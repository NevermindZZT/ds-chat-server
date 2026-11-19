import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  DEFAULT_INHERITED_ENV_VARS,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pool } from './db.js'
import { decryptSecret, encryptSecret } from './security.js'

const HTTP_TRANSPORT = 'streamable-http'
const STDIO_TRANSPORT = 'stdio'
const SERVER_ID_PATTERN = /^[\w.-]{1,128}$/
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/
const SENSITIVE_HEADER_PATTERN =
  /authorization|cookie|token|api[-_]?key|secret|password|credential|auth/i
const BLOCKED_ENV_PATTERN =
  /^(?:PATH|HOME|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR)$/i
const SAFE_STDIO_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]
const MCP_CLIENT_INFO = { name: 'deepseek-chat-server', version: '0.2.3' }

class McpRuntimeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'McpRuntimeError'
    this.code = code
  }
}

function fail(message, code) {
  throw new McpRuntimeError(message, code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name])
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function requestTimeoutMs() {
  return boundedInteger('MCP_REQUEST_TIMEOUT_MS', 10_000, 250, 120_000)
}

function toolTimeoutMs() {
  return boundedInteger('MCP_TOOL_TIMEOUT_MS', 30_000, 250, 300_000)
}

function maxToolCount() {
  return boundedInteger('MCP_MAX_TOOLS', 100, 1, 500)
}

function maxResultBytes() {
  return boundedInteger('MCP_MAX_RESULT_BYTES', 1_048_576, 1_024, 8_388_608)
}

function maxArgumentBytes() {
  return boundedInteger('MCP_MAX_ARGUMENT_BYTES', 65_536, 1_024, 1_048_576)
}

function maxListPages() {
  return boundedInteger('MCP_MAX_TOOL_LIST_PAGES', 20, 1, 100)
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    fail('A valid user ID is required.', 'MCP_INVALID_USER_ID')
  }
}

function assertServerId(serverId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) {
    fail(
      'MCP server ID must contain 1–128 letters, digits, underscores, dots, or hyphens.',
      'MCP_INVALID_SERVER_ID'
    )
  }
}

function parseStdioAllowlist() {
  const raw = process.env.MCP_STDIO_ALLOWLIST?.trim() ?? ''
  if (!raw) {
    return new Set()
  }

  let values
  if (raw.startsWith('[')) {
    try {
      values = JSON.parse(raw)
    } catch {
      fail(
        'MCP_STDIO_ALLOWLIST must be a JSON array or a comma-separated list.',
        'MCP_STDIO_ALLOWLIST_INVALID'
      )
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      fail(
        'MCP_STDIO_ALLOWLIST JSON must contain only command strings.',
        'MCP_STDIO_ALLOWLIST_INVALID'
      )
    }
  } else {
    values = raw.split(/[\n,]/)
  }

  return new Set(values.map((value) => value.trim()).filter(Boolean))
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function normalizeHeaders(value, { secrets = false } = {}) {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isPlainObject(value)) {
    fail(
      'MCP headers must be a plain object of header names and string values.',
      'MCP_INVALID_HEADERS'
    )
  }

  const entries = Object.entries(value)
  if (entries.length > 32) {
    fail('At most 32 MCP headers may be configured.', 'MCP_TOO_MANY_HEADERS')
  }

  const headers = {}
  for (const [name, headerValue] of entries) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      typeof headerValue !== 'string' ||
      headerValue.length > 8_192
    ) {
      fail(
        'MCP header names and values must be valid strings no longer than 8192 characters.',
        'MCP_INVALID_HEADERS'
      )
    }
    if (/[\r\n]/.test(headerValue)) {
      fail('MCP header values cannot contain line breaks.', 'MCP_INVALID_HEADERS')
    }
    if (!secrets && SENSITIVE_HEADER_PATTERN.test(name)) {
      fail(
        `Sensitive header "${name}" must be provided through encrypted secrets.headers.`,
        'MCP_PLAINTEXT_SECRET'
      )
    }
    headers[name] = headerValue
  }
  return headers
}

function normalizeSecretEnv(value) {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isPlainObject(value)) {
    fail(
      'MCP secrets.env must be an object of environment variable names and values.',
      'MCP_INVALID_SECRET_ENV'
    )
  }
  const entries = Object.entries(value)
  if (entries.length > 32) {
    fail(
      'At most 32 MCP stdio secret environment variables may be configured.',
      'MCP_TOO_MANY_SECRET_ENV'
    )
  }

  const env = {}
  for (const [name, envValue] of entries) {
    if (
      !ENV_NAME_PATTERN.test(name) ||
      BLOCKED_ENV_PATTERN.test(name) ||
      typeof envValue !== 'string' ||
      envValue.length > 8_192
    ) {
      fail(
        `MCP stdio secret environment variable "${name}" is invalid or reserved.`,
        'MCP_INVALID_SECRET_ENV'
      )
    }
    env[name] = envValue
  }
  return env
}

function normalizeSecrets(transport, value) {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isPlainObject(value)) {
    fail('MCP secrets must be an object.', 'MCP_INVALID_SECRETS')
  }

  const allowed = transport === HTTP_TRANSPORT ? new Set(['headers']) : new Set(['env'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        `MCP ${transport} secrets may contain only ${[...allowed].join(', ')}.`,
        'MCP_INVALID_SECRETS'
      )
    }
  }

  return transport === HTTP_TRANSPORT
    ? { headers: normalizeHeaders(value.headers, { secrets: true }) }
    : { env: normalizeSecretEnv(value.env) }
}

function normalizeConfig(transport, value) {
  if (!isPlainObject(value)) {
    fail('MCP server config must be a plain object.', 'MCP_INVALID_CONFIG')
  }

  if (transport === HTTP_TRANSPORT) {
    if (Object.hasOwn(value, 'headers')) {
      fail(
        'HTTP headers must be supplied through encrypted secrets.headers.',
        'MCP_PLAINTEXT_SECRET'
      )
    }
    if (typeof value.url !== 'string' || value.url.length > 2_048) {
      fail(
        'Streamable HTTP config requires a URL no longer than 2048 characters.',
        'MCP_INVALID_URL'
      )
    }

    let url
    try {
      url = new URL(value.url)
    } catch {
      fail('MCP server URL is invalid.', 'MCP_INVALID_URL')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      fail(
        'MCP server URL must use HTTP or HTTPS and cannot include embedded credentials.',
        'MCP_INVALID_URL'
      )
    }
    for (const [key] of url.searchParams) {
      if (/token|secret|password|api[-_]?key|authorization/i.test(key)) {
        fail(
          'Credentials must not be placed in the MCP server URL; store them in encrypted secrets.headers.',
          'MCP_URL_CONTAINS_SECRET'
        )
      }
    }

    const headers = normalizeHeaders(value.headers)
    return { url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) }
  }

  if (transport === STDIO_TRANSPORT) {
    if (Object.hasOwn(value, 'env')) {
      fail(
        'stdio environment variables must be supplied through encrypted secrets.env.',
        'MCP_PLAINTEXT_SECRET'
      )
    }
    if (
      typeof value.command !== 'string' ||
      value.command.length > 512 ||
      !/^[\w./:-]+$/.test(value.command)
    ) {
      fail('stdio config requires a simple executable name or path.', 'MCP_INVALID_STDIO_COMMAND')
    }

    const allowlist = parseStdioAllowlist()
    if (!allowlist.has(value.command)) {
      fail(
        'stdio command is not present in MCP_STDIO_ALLOWLIST; stdio execution is disabled unless explicitly allowlisted.',
        'MCP_STDIO_COMMAND_NOT_ALLOWED'
      )
    }

    const args = value.args ?? []
    if (
      !Array.isArray(args) ||
      args.length > 64 ||
      args.some((argument) => typeof argument !== 'string' || argument.length > 8_192)
    ) {
      fail(
        'stdio args must be an array of at most 64 strings, each no longer than 8192 characters.',
        'MCP_INVALID_STDIO_ARGS'
      )
    }
    if (args.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > 32_768) {
      fail('stdio arguments exceed the 32768-byte limit.', 'MCP_STDIO_ARGS_TOO_LARGE')
    }

    const cwdRoot = path.resolve(process.env.MCP_STDIO_CWD_ROOT ?? process.cwd())
    if (typeof value.cwd !== 'undefined' && typeof value.cwd !== 'string') {
      fail('stdio cwd must be a relative or absolute path string.', 'MCP_INVALID_STDIO_CWD')
    }
    const cwd = value.cwd === undefined ? cwdRoot : path.resolve(cwdRoot, value.cwd)
    if (!isInside(cwdRoot, cwd)) {
      fail('stdio cwd must remain inside MCP_STDIO_CWD_ROOT.', 'MCP_STDIO_CWD_NOT_ALLOWED')
    }
    return { command: value.command, args: [...args], cwd }
  }

  fail('MCP transport must be "streamable-http" or "stdio".', 'MCP_UNSUPPORTED_TRANSPORT')
}

function toJsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    fail('MCP value is not serializable JSON.', 'MCP_INVALID_JSON')
  }
}

function normalizeStoredSecrets(transport, plaintext) {
  if (!plaintext) {
    return normalizeSecrets(transport, {})
  }
  try {
    return normalizeSecrets(transport, JSON.parse(plaintext))
  } catch (error) {
    if (error instanceof McpRuntimeError) {
      throw error
    }
    fail('Stored MCP credentials could not be decrypted or parsed.', 'MCP_SECRET_DECRYPT_FAILED')
  }
}

function safeAmbientEnv() {
  // The SDK merges DEFAULT_INHERITED_ENV_VARS even when env is supplied. Override every
  // inherited value first, then restore only this module's explicit environment allowlist.
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, '']))
  for (const name of SAFE_STDIO_ENV) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length <= 8_192) {
      env[name] = value
    }
  }
  return env
}

function createBoundedFetch(byteLimit) {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init)
    if (!response.body) {
      return response
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > byteLimit) {
      await response.body.cancel().catch(() => {})
      fail(`MCP HTTP response exceeded the ${byteLimit}-byte limit.`, 'MCP_RESPONSE_TOO_LARGE')
    }

    const reader = response.body.getReader()
    let total = 0
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            reader.releaseLock()
            controller.close()
            return
          }
          total += value.byteLength
          if (total > byteLimit) {
            await reader.cancel().catch(() => {})
            controller.error(
              new McpRuntimeError(
                `MCP HTTP response exceeded the ${byteLimit}-byte limit.`,
                'MCP_RESPONSE_TOO_LARGE'
              )
            )
            return
          }
          controller.enqueue(value)
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {})
      },
    })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

function createTransport(row, secrets) {
  const config = normalizeConfig(row.transport, row.config)
  const secretValues = normalizeSecrets(row.transport, secrets)

  if (row.transport === HTTP_TRANSPORT) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: secretValues.headers, redirect: 'error' },
      redirectPolicy: 'same-origin',
      fetch: createBoundedFetch(maxResultBytes()),
    })
  }

  const allowlist = parseStdioAllowlist()
  if (!allowlist.has(config.command)) {
    fail(
      'stdio command is no longer present in MCP_STDIO_ALLOWLIST.',
      'MCP_STDIO_COMMAND_NOT_ALLOWED'
    )
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: { ...safeAmbientEnv(), ...secretValues.env },
    stderr: 'ignore',
    maxBufferSize: maxResultBytes(),
  })
}

function abortReason(signal, fallbackCode, fallbackMessage) {
  if (signal?.reason instanceof McpRuntimeError) {
    return signal.reason
  }
  if (signal?.aborted) {
    return new McpRuntimeError('MCP operation was cancelled.', 'MCP_ABORTED')
  }
  return new McpRuntimeError(fallbackMessage, fallbackCode)
}

/**
 * Run one SDK request with both caller cancellation and a hard wall-clock limit.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation - SDK request to run.
 * @param {AbortSignal | undefined} parentSignal - Optional caller cancellation.
 * @param {number} timeoutMs - Maximum request duration.
 * @param {string} label - Human-readable operation label.
 * @returns {Promise<T>} The SDK request result.
 */
async function withDeadline(operation, parentSignal, timeoutMs, label) {
  if (parentSignal?.aborted) {
    throw abortReason(parentSignal, 'MCP_ABORTED', 'MCP operation was cancelled.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new McpRuntimeError(`MCP ${label} timed out after ${timeoutMs} ms.`, 'MCP_TIMEOUT')
    )
  }, timeoutMs)
  timer.unref?.()
  const onParentAbort = () =>
    controller.abort(
      parentSignal.reason ?? new McpRuntimeError('MCP operation was cancelled.', 'MCP_ABORTED')
    )
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })

  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () =>
      reject(
        abortReason(
          controller.signal,
          'MCP_TIMEOUT',
          `MCP ${label} timed out after ${timeoutMs} ms.`
        )
      )
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted])
  } catch (error) {
    if (controller.signal.aborted) {
      throw abortReason(
        controller.signal,
        'MCP_TIMEOUT',
        `MCP ${label} timed out after ${timeoutMs} ms.`
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Add one high-level timeout while preserving an optional caller signal.
 * @param {AbortSignal | undefined} parentSignal - Optional caller cancellation.
 * @param {number} timeoutMs - Maximum duration for the complete operation.
 * @param {string} label - Human-readable operation label.
 * @returns {{signal: AbortSignal, dispose: () => void}} Combined deadline and cleanup.
 */
function createOperationDeadline(parentSignal, timeoutMs, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new McpRuntimeError(`MCP ${label} exceeded ${timeoutMs} ms.`, 'MCP_TIMEOUT'))
  }, timeoutMs)
  timer.unref?.()
  const onParentAbort = () =>
    controller.abort(
      parentSignal.reason ?? new McpRuntimeError('MCP operation was cancelled.', 'MCP_ABORTED')
    )
  if (parentSignal?.aborted) {
    onParentAbort()
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
  }
}

function toPublicError(error, fallbackCode, fallbackMessage) {
  if (error instanceof McpRuntimeError) {
    return error
  }
  return new McpRuntimeError(fallbackMessage, fallbackCode)
}

async function closeQuietly(resource) {
  try {
    await resource?.close?.()
  } catch {
    // Cleanup must not hide the MCP operation's original result or error.
  }
}

function decodeStoredServer(row) {
  if (!row) {
    return null
  }
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    enabled: Boolean(row.enabled),
  }
}

async function getStoredServer(userId, serverId, { enabledOnly = false } = {}) {
  assertUserId(userId)
  assertServerId(serverId)
  const { rows } = await pool.query(
    `SELECT server_id AS id,name,transport,config,encrypted_secrets AS "encryptedSecrets",enabled,updated_at AS "updatedAt"
     FROM mcp_servers WHERE user_id=$1 AND server_id=$2${enabledOnly ? ' AND enabled=true' : ''}`,
    [userId, serverId]
  )
  return decodeStoredServer(rows[0] ?? null)
}

async function getStoredServers(userId, onlyEnabled) {
  assertUserId(userId)
  const { rows } = await pool.query(
    `SELECT server_id AS id,name,transport,config,encrypted_secrets AS "encryptedSecrets",enabled,updated_at AS "updatedAt"
     FROM mcp_servers WHERE user_id=$1${onlyEnabled ? ' AND enabled=true' : ''} ORDER BY name,server_id`,
    [userId]
  )
  return rows.map((row) => decodeStoredServer(row))
}

async function withMcpClient(
  row,
  parentSignal,
  operation,
  { operationLabel = 'MCP request', operationCode = 'MCP_REQUEST_FAILED' } = {}
) {
  let plaintext
  try {
    plaintext = row.encryptedSecrets ? await decryptSecret(row.encryptedSecrets) : null
  } catch {
    fail('Stored MCP credentials could not be decrypted.', 'MCP_SECRET_DECRYPT_FAILED')
  }
  const secrets = normalizeStoredSecrets(row.transport, plaintext)
  let transport
  let client
  try {
    try {
      transport = createTransport(row, secrets)
      client = new Client(MCP_CLIENT_INFO, { capabilities: {} })
      const timeoutMs = requestTimeoutMs()
      await withDeadline(
        (signal) =>
          client.connect(transport, { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
        parentSignal,
        timeoutMs,
        'connection'
      )
    } catch (error) {
      throw toPublicError(
        error,
        'MCP_CONNECTION_FAILED',
        `Could not connect to MCP server "${row.name}".`
      )
    }

    try {
      return await operation(client)
    } catch (error) {
      throw toPublicError(
        error,
        operationCode,
        `${operationLabel} failed for MCP server "${row.name}".`
      )
    }
  } finally {
    await closeQuietly(client)
    await closeQuietly(transport)
  }
}

function normalizeTool(tool, server) {
  if (
    !isPlainObject(tool) ||
    typeof tool.name !== 'string' ||
    !tool.name ||
    tool.name.length > 256
  ) {
    fail(
      `MCP server "${server.name}" returned an invalid tool definition.`,
      'MCP_INVALID_TOOL_SCHEMA'
    )
  }
  const inputSchema = isPlainObject(tool.inputSchema)
    ? tool.inputSchema
    : { type: 'object', properties: {} }
  if (toJsonByteLength(inputSchema) > 64 * 1024) {
    fail(`MCP tool "${tool.name}" input schema exceeds 65536 bytes.`, 'MCP_TOOL_SCHEMA_TOO_LARGE')
  }
  return {
    serverId: server.id,
    serverName: server.name,
    qualifiedName: `${server.id}::${tool.name}`,
    name: tool.name,
    title: typeof tool.title === 'string' ? tool.title.slice(0, 256) : undefined,
    description: typeof tool.description === 'string' ? tool.description.slice(0, 8_192) : '',
    inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }
}

/**
 * Read one server's MCP tool catalog without invoking any tools.
 * @param {Client} client - Connected MCP SDK client.
 * @param {object} server - Stored server metadata.
 * @param {AbortSignal | undefined} signal - Optional cancellation signal.
 * @param {number} limit - Maximum number of schemas to retain.
 * @returns {Promise<{tools: object[], truncated: boolean}>} Bounded tool catalog.
 */
async function readToolCatalog(client, server, signal, limit) {
  const tools = []
  const cursors = new Set()
  let cursor
  let truncated = false
  const pagesLimit = maxListPages()
  const timeoutMs = requestTimeoutMs()

  for (let pageNumber = 0; pageNumber < pagesLimit; pageNumber += 1) {
    const page = await withDeadline(
      (requestSignal) =>
        client.listTools(cursor ? { cursor } : undefined, {
          signal: requestSignal,
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
        }),
      signal,
      timeoutMs,
      'tool listing'
    )

    for (const tool of page.tools ?? []) {
      if (tools.length >= limit) {
        truncated = true
        break
      }
      tools.push(normalizeTool(tool, server))
    }

    if (truncated || !page.nextCursor) {
      return { tools, truncated }
    }
    if (cursors.has(page.nextCursor)) {
      fail(`MCP server "${server.name}" repeated a tool-list cursor.`, 'MCP_TOOL_LIST_CURSOR_LOOP')
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  return { tools, truncated: true }
}

function safeConfigForList(transport, value) {
  if (!isPlainObject(value)) {
    return {}
  }
  if (transport === HTTP_TRANSPORT) {
    const safe = {}
    if (typeof value.url === 'string') {
      try {
        const url = new URL(value.url)
        url.username = ''
        url.password = ''
        url.hash = ''
        for (const key of [...url.searchParams.keys()]) {
          if (/token|secret|password|api[-_]?key|authorization|credential|auth/i.test(key)) {
            url.searchParams.delete(key)
          }
        }
        safe.url = url.toString()
      } catch {
        // Do not expose malformed legacy URLs.
      }
    }
    if (isPlainObject(value.headers)) {
      const headers = {}
      for (const [name, headerValue] of Object.entries(value.headers)) {
        if (
          HEADER_NAME_PATTERN.test(name) &&
          !SENSITIVE_HEADER_PATTERN.test(name) &&
          typeof headerValue === 'string' &&
          !/[\r\n]/.test(headerValue) &&
          headerValue.length <= 8_192
        ) {
          headers[name] = headerValue
        }
      }
      if (Object.keys(headers).length) {
        safe.headers = headers
      }
    }
    return safe
  }

  const safe = {}
  if (typeof value.command === 'string') {
    safe.command = value.command
  }
  if (Array.isArray(value.args)) {
    const args = []
    let redactNext = false
    const secretFlag =
      /(?:^|[-_])(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|credential|token)(?:=|$)/i
    for (const argument of value.args) {
      if (typeof argument !== 'string') {
        continue
      }
      if (redactNext) {
        args.push('<redacted>')
        redactNext = false
        continue
      }
      if (secretFlag.test(argument) || /(?:authorization:\s*|bearer\s+)/i.test(argument)) {
        const separator = argument.indexOf('=')
        if (separator >= 0) {
          args.push(`${argument.slice(0, separator + 1)}<redacted>`)
        } else {
          args.push(argument)
          redactNext = true
        }
      } else {
        args.push(argument)
      }
    }
    safe.args = args
  }
  if (typeof value.cwd === 'string') {
    safe.cwd = value.cwd
  }
  return safe
}

/**
 * List this user's MCP servers without returning encrypted or plaintext credentials.
 * Legacy config fields that resemble credentials are omitted or redacted.
 * @param {string} userId - Authenticated account UUID.
 * @returns {Promise<Array<{id: string, name: string, transport: string, config: object, enabled: boolean, updatedAt: Date}>>}
 */
export async function listMcpServers(userId) {
  assertUserId(userId)
  const { rows } = await pool.query(
    `SELECT server_id AS id,name,transport,config,enabled,updated_at AS "updatedAt"
     FROM mcp_servers WHERE user_id=$1 ORDER BY name,server_id`,
    [userId]
  )
  return rows.map((row) => {
    const decoded = decodeStoredServer(row)
    return {
      ...decoded,
      config: safeConfigForList(decoded.transport, decoded.config),
    }
  })
}

/**
 * Create or update one user's MCP server. HTTP credentials belong in `secrets.headers`;
 * stdio credentials belong in `secrets.env`. Secrets are encrypted before persistence.
 * If `secrets` is omitted or undefined on update, previously stored secrets are retained;
 * pass null or an empty object to clear them. Omitted `enabled` preserves the current state.
 * @param {string} userId - Authenticated account UUID.
 * @param {{id: string, name: string, transport: 'streamable-http'|'stdio', config: object, secrets?: object|null, enabled?: boolean}} input - Server definition.
 * @returns {Promise<{id: string, name: string, transport: string, config: object, enabled: boolean, updatedAt: Date}>} Saved non-secret server metadata.
 */
export async function saveMcpServer(userId, input) {
  assertUserId(userId)
  if (!isPlainObject(input)) {
    fail('MCP server definition must be an object.', 'MCP_INVALID_SERVER')
  }
  const { id, name, transport } = input
  assertServerId(id)
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) {
    fail('MCP server name must contain 1–128 characters.', 'MCP_INVALID_NAME')
  }
  if (![HTTP_TRANSPORT, STDIO_TRANSPORT].includes(transport)) {
    fail('MCP transport must be "streamable-http" or "stdio".', 'MCP_UNSUPPORTED_TRANSPORT')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    fail('MCP enabled must be a boolean when provided.', 'MCP_INVALID_ENABLED')
  }

  const config = normalizeConfig(transport, input.config)
  const configBytes = toJsonByteLength(config)
  if (configBytes > 32 * 1024) {
    fail('MCP server config exceeds 32768 bytes.', 'MCP_CONFIG_TOO_LARGE')
  }

  const hasSecrets = Object.hasOwn(input, 'secrets') && input.secrets !== undefined
  let encryptedSecrets = null
  if (hasSecrets) {
    const secrets = normalizeSecrets(transport, input.secrets)
    if (
      Object.keys(secrets).length &&
      Object.values(secrets).some((value) => Object.keys(value).length)
    ) {
      encryptedSecrets = await encryptSecret(JSON.stringify(secrets))
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO mcp_servers(user_id,server_id,name,transport,config,encrypted_secrets,enabled)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,COALESCE($8::boolean,false))
     ON CONFLICT(user_id,server_id) DO UPDATE SET
       name=EXCLUDED.name,
       transport=EXCLUDED.transport,
       config=EXCLUDED.config,
       encrypted_secrets=CASE WHEN $7::boolean THEN $6 ELSE mcp_servers.encrypted_secrets END,
       enabled=COALESCE($8::boolean,mcp_servers.enabled),
       updated_at=now()
     RETURNING server_id AS id,name,transport,config,enabled,updated_at AS "updatedAt"`,
    [
      userId,
      id,
      name.trim(),
      transport,
      JSON.stringify(config),
      encryptedSecrets,
      hasSecrets,
      input.enabled ?? null,
    ]
  )
  const saved = decodeStoredServer(rows[0])
  return { ...saved, config: safeConfigForList(saved.transport, saved.config) }
}

/**
 * Delete one MCP server belonging to this user. It does not affect other users' rows.
 * @param {string} userId - Authenticated account UUID.
 * @param {string} id - MCP server ID.
 * @returns {Promise<boolean>} True when a row was removed.
 */
export async function deleteMcpServer(userId, id) {
  assertUserId(userId)
  assertServerId(id)
  const { rowCount } = await pool.query(
    'DELETE FROM mcp_servers WHERE user_id=$1 AND server_id=$2',
    [userId, id]
  )
  return rowCount > 0
}

/**
 * Connect to one server, read its reported identity and bounded tool catalog, then close it.
 * This method never calls MCP tools.
 * @param {string} userId - Authenticated account UUID.
 * @param {string} id - MCP server ID.
 * @param {AbortSignal} [signal] - Optional request cancellation.
 * @returns {Promise<{id: string, name: string, transport: string, enabled: boolean, serverInfo: object|null, instructions: string|null, tools: object[], toolsTruncated: boolean}>}
 */
export async function probeMcpServer(userId, id, signal) {
  const row = await getStoredServer(userId, id)
  if (!row) {
    fail('MCP server was not found for this user.', 'MCP_SERVER_NOT_FOUND')
  }

  const deadline = createOperationDeadline(
    signal,
    boundedInteger('MCP_PROBE_TIMEOUT_MS', 60_000, 1_000, 300_000),
    'probe'
  )
  try {
    return await withMcpClient(
      row,
      deadline.signal,
      async (client) => {
        const catalog = await readToolCatalog(client, row, deadline.signal, maxToolCount())
        const instructions = client.getInstructions()
        return {
          id: row.id,
          name: row.name,
          transport: row.transport,
          enabled: row.enabled,
          serverInfo: client.getServerVersion() ?? null,
          instructions: typeof instructions === 'string' ? instructions.slice(0, 8_192) : null,
          tools: catalog.tools,
          toolsTruncated: catalog.truncated,
        }
      },
      { operationLabel: 'MCP probe', operationCode: 'MCP_PROBE_FAILED' }
    )
  } finally {
    deadline.dispose()
  }
}

/**
 * Discover tools for this user's servers without executing them. Listing fails clearly if a
 * server is unavailable or the configured server/tool limits would produce an incomplete catalog.
 * @param {string} userId - Authenticated account UUID.
 * @param {boolean} [onlyEnabled=true] - When false, also probe disabled rows for discovery.
 * @returns {Promise<object[]>} Bounded tools with server ID, name, schema, and qualified name.
 */
export async function listMcpTools(userId, onlyEnabled = true) {
  if (typeof onlyEnabled !== 'boolean') {
    fail('onlyEnabled must be a boolean.', 'MCP_INVALID_FILTER')
  }
  const servers = await getStoredServers(userId, onlyEnabled)
  const serverLimit = boundedInteger('MCP_MAX_SERVERS_PER_LIST', 50, 1, 200)
  if (servers.length > serverLimit) {
    fail(
      `MCP server count exceeds the configured ${serverLimit}-server discovery limit.`,
      'MCP_SERVER_LIST_LIMIT'
    )
  }

  const totalLimit = boundedInteger('MCP_MAX_TOTAL_TOOLS', 500, 1, 2_000)
  const deadline = createOperationDeadline(
    undefined,
    boundedInteger('MCP_LIST_TIMEOUT_MS', 60_000, 1_000, 300_000),
    'tool discovery'
  )
  const tools = []

  try {
    for (const server of servers) {
      if (tools.length >= totalLimit) {
        fail(
          `MCP tool catalog exceeds the configured ${totalLimit}-tool limit.`,
          'MCP_TOOL_LIST_LIMIT'
        )
      }
      const perServerLimit = Math.min(maxToolCount(), totalLimit - tools.length)
      const catalog = await withMcpClient(
        server,
        deadline.signal,
        (client) => readToolCatalog(client, server, deadline.signal, perServerLimit),
        { operationLabel: 'MCP tool listing', operationCode: 'MCP_TOOL_LIST_FAILED' }
      )
      if (catalog.truncated) {
        fail(
          `MCP server "${server.name}" advertises more than the configured ${perServerLimit}-tool listing limit.`,
          'MCP_TOOL_LIST_LIMIT'
        )
      }
      tools.push(...catalog.tools)
    }

    return tools
  } finally {
    deadline.dispose()
  }
}

function parseQualifiedName(qualifiedName) {
  if (typeof qualifiedName !== 'string' || qualifiedName.length > 512) {
    fail(
      'qualifiedName must be a string no longer than 512 characters.',
      'MCP_INVALID_QUALIFIED_NAME'
    )
  }
  const separator = qualifiedName.indexOf('::')
  if (separator < 1 || separator + 2 >= qualifiedName.length) {
    fail('qualifiedName must use the format serverId::toolName.', 'MCP_INVALID_QUALIFIED_NAME')
  }
  const serverId = qualifiedName.slice(0, separator)
  const toolName = qualifiedName.slice(separator + 2)
  assertServerId(serverId)
  const hasControlCharacter = [...toolName].some((character) => {
    const code = character.codePointAt(0)
    return code <= 31 || (code >= 127 && code <= 159)
  })
  if (toolName.length > 256 || hasControlCharacter) {
    fail('MCP tool name is invalid.', 'MCP_INVALID_TOOL_NAME')
  }
  return { serverId, toolName }
}

function normalizeToolArguments(args) {
  if (!isPlainObject(args)) {
    fail('MCP tool arguments must be a JSON object.', 'MCP_INVALID_TOOL_ARGUMENTS')
  }
  if (toJsonByteLength(args) > maxArgumentBytes()) {
    fail(
      `MCP tool arguments exceed the ${maxArgumentBytes()}-byte limit.`,
      'MCP_ARGUMENTS_TOO_LARGE'
    )
  }
  return args
}

function boundToolResult(result) {
  if (toJsonByteLength(result) <= maxResultBytes()) {
    return result
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `MCP tool result exceeded the ${maxResultBytes()}-byte limit and was omitted.`,
      },
    ],
  }
}

/**
 * Invoke one enabled MCP tool identified by `serverId::toolName`. The server is reconnected,
 * the tool name is checked against its live catalog, and both client and transport are closed
 * even if connect, discovery, execution, cancellation, or result validation fails.
 * @param {string} userId - Authenticated account UUID.
 * @param {string} qualifiedName - Qualified tool name in the form `serverId::toolName`.
 * @param {Record<string, unknown>} args - JSON object passed as MCP tool arguments.
 * @param {AbortSignal} [signal] - Optional caller cancellation.
 * @returns {Promise<object>} Bounded MCP CallToolResult, including `isError` when supplied.
 */
export async function callMcpTool(userId, qualifiedName, args, signal) {
  const { serverId, toolName } = parseQualifiedName(qualifiedName)
  const toolArguments = normalizeToolArguments(args)
  const row = await getStoredServer(userId, serverId, { enabledOnly: true })
  if (!row) {
    fail('MCP server was not found or is disabled.', 'MCP_SERVER_NOT_AVAILABLE')
  }

  const deadline = createOperationDeadline(
    signal,
    boundedInteger('MCP_TOOL_TOTAL_TIMEOUT_MS', 90_000, 1_000, 600_000),
    'tool call'
  )
  try {
    return await withMcpClient(
      row,
      deadline.signal,
      async (client) => {
        const catalog = await readToolCatalog(client, row, deadline.signal, maxToolCount())
        if (!catalog.tools.some((tool) => tool.name === toolName)) {
          fail(
            `Tool "${toolName}" is not currently advertised by MCP server "${row.name}".`,
            'MCP_TOOL_NOT_FOUND'
          )
        }

        const timeoutMs = toolTimeoutMs()
        const result = await withDeadline(
          (requestSignal) =>
            client.callTool({ name: toolName, arguments: toolArguments }, undefined, {
              signal: requestSignal,
              timeout: timeoutMs,
              maxTotalTimeout: timeoutMs,
            }),
          deadline.signal,
          timeoutMs,
          `tool "${toolName}" execution`
        )
        return boundToolResult(result)
      },
      { operationLabel: `MCP tool "${toolName}" execution`, operationCode: 'MCP_TOOL_CALL_FAILED' }
    )
  } finally {
    deadline.dispose()
  }
}
