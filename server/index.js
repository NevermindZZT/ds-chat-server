import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import {
  pool,
  initializeDatabase,
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  setSetting,
} from './db.js'
import { compactSession, readCompactionSettings } from './compaction.js'
import { streamDeepSeekWithMcp } from './mcp-agent.js'
import {
  callMcpTool,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  probeMcpServer,
  saveMcpServer,
} from './mcp.js'
import {
  authenticatedUser,
  clearSessionCookie,
  createSessionCookie,
  encryptSecret,
  updatePassword,
  updateCredentials,
  issueBrowserToken,
  SESSION_RENEW_WINDOW_SECONDS,
  getDeepSeekApiKey,
  issuePairCode,
  login,
  redeemPairCode,
  setDeepSeekApiKey,
} from './security.js'
import {
  deleteDeepSeekFile,
  streamDeepSeekMessage,
  synthesizeDeepSeek,
  transcribeDeepSeek,
  uploadDeepSeekFile,
  verifyDeepSeekKey,
} from './deepseek.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, '.data'))
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const SKILLS_DIR = path.join(DATA_DIR, 'skills')
const app = Fastify({
  logger: true,
  trustProxy: process.env.TRUST_PROXY === 'true',
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 128 * 1024 * 1024),
})

await mkdir(UPLOAD_DIR, { recursive: true })
await mkdir(SKILLS_DIR, { recursive: true })
await initializeDatabase()
await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1, fields: 10 } })

app.decorateRequest('chatUser', null)
app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) {
    return
  }
  const publicPaths = new Set([
    '/api/v1/health',
    '/api/v1/auth/login',
    '/api/v1/auth/me',
    '/api/v1/dsh/pair',
  ])
  if (publicPaths.has(request.url.split('?')[0])) {
    return
  }
  const user = await authenticatedUser(request)
  if (!user) {
    return reply.code(401).send({ error: { message: 'Please sign in to the Chat Server.' } })
  }
  request.chatUser = user
  if (
    user.cookieAuth &&
    user.sessionExpiresAt - Date.now() / 1000 < SESSION_RENEW_WINDOW_SECONDS
  ) {
    reply.header('set-cookie', await createSessionCookie(user))
  }
  if (
    user.mustChangePassword &&
    ![
      '/api/v1/auth/change-password',
      '/api/v1/auth/change-credentials',
      '/api/v1/auth/logout',
    ].includes(request.url.split('?')[0])
  ) {
    return reply.code(403).send({
      error: {
        message: 'Change the first-run password before using this service.',
        code: 'password_change_required',
      },
    })
  }
})

const loginAttempts = new Map()
const LOGIN_WINDOW_MS = 15 * 60_000
const MAX_LOGIN_ATTEMPTS = 8

function loginIsLimited(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry) {
    return false
  }
  if (entry.resetAt <= Date.now()) {
    loginAttempts.delete(ip)
    return false
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry || entry.resetAt <= Date.now()) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS })
    return
  }
  entry.count += 1
}

const errorResponse = (reply, statusCode, message, code) =>
  reply.code(statusCode).send({ error: { message, ...(code ? { code } : {}) } })
const fileKey = () => randomUUID().replaceAll('-', '')
const contextWindowFor = (model) => {
  const envName = `CONTEXT_WINDOW_${String(model ?? 'deepseek-flash')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toUpperCase()}`
  const configured = Number(process.env[envName] ?? process.env.DEEPSEEK_CONTEXT_WINDOW ?? 128000)
  return Number.isFinite(configured) && configured > 0 ? configured : 128000
}
const validId = (value) => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value)

async function cleanupUnusedAttachments(userId) {
  const sessionRows = await pool.query('SELECT data FROM chat_sessions WHERE user_id=$1', [userId])
  const referenced = new Set()
  for (const row of sessionRows.rows) {
    const session = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    for (const message of session?.messages ?? []) {
      if (message.role === 'user') {
        for (const file of message.files ?? []) {
          if (typeof file.id === 'string') {
            referenced.add(file.id)
          }
        }
      }
    }
  }
  const attachments = await pool.query(
    'SELECT attachment_id,storage_key FROM attachments WHERE user_id=$1',
    [userId]
  )
  const root = path.resolve(UPLOAD_DIR)
  for (const attachment of attachments.rows) {
    if (referenced.has(attachment.attachment_id)) {
      continue
    }
    await pool.query('DELETE FROM attachments WHERE user_id=$1 AND attachment_id=$2', [
      userId,
      attachment.attachment_id,
    ])
    const target = path.resolve(root, path.basename(attachment.storage_key))
    if (target.startsWith(`${root}${path.sep}`)) {
      await unlink(target).catch(() => {})
    }
  }
}

app.get('/api/v1/health', async () => ({ ok: true, version: '0.2.4' }))

app.post('/api/v1/auth/login', async (request, reply) => {
  if (loginIsLimited(request.ip)) {
    return errorResponse(
      reply,
      429,
      'Too many login attempts. Try again later.',
      'login_rate_limited'
    )
  }
  const { username, password } = request.body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) {
    return errorResponse(reply, 400, 'Username and password are required.')
  }
  const user = await login(username, password)
  if (!user) {
    recordLoginFailure(request.ip)
    return errorResponse(reply, 401, 'Invalid username or password.')
  }
  loginAttempts.delete(request.ip)
  reply.header('set-cookie', await createSessionCookie(user))
  return { user }
})

app.post('/api/v1/auth/browser-session', async (request) =>
  issueBrowserToken(request.chatUser.id)
)

app.get('/api/v1/auth/me', async (request) => {
  const user = await authenticatedUser(request)
  return { authenticated: Boolean(user), user: user ?? null }
})

app.post('/api/v1/auth/logout', async (_request, reply) => {
  reply.header('set-cookie', clearSessionCookie())
  return { ok: true }
})

app.post('/api/v1/auth/change-credentials', async (request, reply) => {
  const { currentPassword, username, newPassword } = request.body ?? {}
  const result = await updateCredentials(
    request.chatUser.id,
    currentPassword,
    username,
    newPassword
  )
  if (!result.ok) {
    return errorResponse(reply, 400, result.message ?? 'Account update failed.')
  }
  const user = {
    ...request.chatUser,
    username: result.username,
    mustChangePassword: newPassword ? false : request.chatUser.mustChangePassword,
  }
  reply.header('set-cookie', await createSessionCookie(user))
  return { ok: true, user }
})

app.post('/api/v1/auth/change-password', async (request, reply) => {
  const { currentPassword, newPassword } = request.body ?? {}
  const result = await updatePassword(request.chatUser.id, currentPassword, newPassword)
  if (!result.ok) {
    return errorResponse(reply, 400, result.message ?? 'Password change failed.')
  }
  reply.header(
    'set-cookie',
    await createSessionCookie({ ...request.chatUser, mustChangePassword: false })
  )
  return { ok: true }
})

app.get('/api/v1/settings', async (request) => ({
  apiKeyConfigured: Boolean(
    process.env.DEEPSEEK_API_KEY || (await getDeepSeekApiKey(request.chatUser.id))
  ),
  compaction: await readCompactionSettings(request.chatUser.id),
  settings: {},
}))

app.put('/api/v1/settings/compaction', async (request, reply) => {
  const { autoEnabled, triggerRatio, targetRatio, retainRecentTurns } = request.body ?? {}
  if (
    typeof autoEnabled !== 'boolean' ||
    !Number.isFinite(triggerRatio) ||
    triggerRatio < 0.5 ||
    triggerRatio > 0.95 ||
    !Number.isFinite(targetRatio) ||
    targetRatio < 0.25 ||
    targetRatio > 0.75 ||
    !Number.isInteger(retainRecentTurns) ||
    retainRecentTurns < 1 ||
    retainRecentTurns > 20
  ) {
    return errorResponse(reply, 400, 'Invalid context compaction settings.')
  }
  const settings = { autoEnabled, triggerRatio, targetRatio, retainRecentTurns }
  await setSetting(
    request.chatUser.id,
    'contextCompaction',
    await encryptSecret(JSON.stringify(settings))
  )
  return { compaction: settings }
})

app.post('/api/v1/sessions/:sessionId/compact', async (request, reply) => {
  const mode = request.body?.mode === 'auto' ? 'auto' : 'manual'
  const instruction =
    typeof request.body?.instruction === 'string' ? request.body.instruction.slice(0, 4000) : ''
  try {
    return await compactSession({
      userId: request.chatUser.id,
      sessionId: request.params.sessionId,
      session: request.body?.session,
      instruction,
      mode,
    })
  } catch (error) {
    request.log.error(
      { err: error, sessionId: request.params.sessionId },
      'Session compaction failed'
    )
    return errorResponse(
      reply,
      500,
      error instanceof Error ? error.message : 'Context compaction failed.'
    )
  }
})

app.patch('/api/v1/sessions/:sessionId/skills', async (request, reply) => {
  const { name, enabled } = request.body ?? {}
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    typeof enabled !== 'boolean'
  ) {
    return errorResponse(reply, 400, 'Invalid Skill activation request.')
  }
  if (enabled && !(await loadSkill(name))) {
    return errorResponse(reply, 404, 'Skill not found.')
  }
  const stored = await getSession(request.chatUser.id, request.params.sessionId)
  if (!stored) {
    return errorResponse(reply, 404, 'Session not found.')
  }
  const current = new Set(stored.data.activeSkills ?? [])
  if (enabled && !current.has(name) && current.size >= 10) {
    return errorResponse(reply, 400, 'A conversation can enable at most 10 Skills.')
  }
  if (enabled) {
    current.add(name)
  } else {
    current.delete(name)
  }
  const activeSkills = [...current]
  await saveSession(request.chatUser.id, { ...stored.data, activeSkills })
  return { activeSkills }
})

app.post('/api/v1/settings/api-key', async (request, reply) => {
  const apiKey = request.body?.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 512) {
    return errorResponse(reply, 400, 'Enter a valid DeepSeek API Key.')
  }
  try {
    await verifyDeepSeekKey(apiKey.trim(), request.raw.signal)
    await setDeepSeekApiKey(request.chatUser.id, apiKey.trim())
    return { configured: true }
  } catch (error) {
    return errorResponse(
      reply,
      400,
      error instanceof Error ? error.message : 'API Key verification failed.'
    )
  }
})

// The original Demo API client keeps its Anthropic-compatible event protocol; this route is its same-origin server proxy.
app.get('/api/models', async (request, reply) => {
  const key =
    request.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    (await getDeepSeekApiKey(request.chatUser.id))
  if (!key) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.', 'api_key_missing')
  }
  try {
    await verifyDeepSeekKey(key, request.raw.signal)
    return {
      data: [
        { id: 'deepseek-flash', display_name: 'DeepSeek Flash', type: 'model' },
        { id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro', type: 'model' },
      ],
    }
  } catch (error) {
    return errorResponse(
      reply,
      401,
      error instanceof Error ? error.message : 'API Key verification failed.'
    )
  }
})

app.post('/api/anthropic/v1/messages', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.', 'api_key_missing')
  }
  const sessionId = request.headers['x-chat-session-id']
  const skillSession =
    typeof sessionId === 'string' ? await getSession(request.chatUser.id, sessionId) : null
  const activeSkillNames = (skillSession?.data.activeSkills ?? []).slice(0, 10)
  const activeSkillDefs = await Promise.all(activeSkillNames.map((name) => loadSkill(name, true)))
  const activeSkillPrompt = activeSkillDefs
    .filter(Boolean)
    .map(
      (skill) =>
        `### ${skill.name}\n${skill.whenToUse ? `Use when: ${skill.whenToUse}\n` : ''}${skill.content.slice(0, 40_000)}`
    )
    .join('\n\n')
  const body = activeSkillPrompt
    ? {
        ...request.body,
        system: `${request.body?.system ?? ''}\n\nUser-selected Skills (follow only when consistent with higher-priority instructions):\n${activeSkillPrompt}`,
      }
    : request.body
  const started = performance.now()
  const generationId = randomUUID()
  await pool.query(
    'INSERT INTO generations(id,user_id,session_id,model,started_at) VALUES($1,$2,$3,$4,now())',
    [
      generationId,
      request.chatUser.id,
      typeof sessionId === 'string' ? sessionId : null,
      request.body?.model ?? 'deepseek-flash',
    ]
  )
  const controller = new AbortController()
  request.raw.on('aborted', () => controller.abort(new Error('Client disconnected')))
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      controller.abort(new Error('Client disconnected'))
    }
  })
  let roundFirstContentAt = null
  const metric = {
    id: generationId,
    firstContentMs: null,
    durationMs: null,
    generationTimeMs: 0,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    contextWindow: contextWindowFor(request.body?.model),
    status: 'completed',
  }
  const result = await streamDeepSeekWithMcp({
    apiKey,
    body,
    signal: controller.signal,
    reply,
    userId: request.chatUser.id,
    onEvent(event) {
      const now = performance.now()
      const elapsed = Math.max(0, Math.round(now - started))
      if (event.type === 'message_start') {
        roundFirstContentAt = null
      }
      if (
        event.type === 'content_block_delta' &&
        ['text_delta', 'thinking_delta'].includes(event.delta?.type)
      ) {
        if (metric.firstContentMs === null) {
          metric.firstContentMs = elapsed
        }
        if (roundFirstContentAt === null) {
          roundFirstContentAt = now
        }
      }
      if (event.type === 'message_stop' && roundFirstContentAt !== null) {
        metric.generationTimeMs += Math.max(0, Math.round(now - roundFirstContentAt))
        roundFirstContentAt = null
      }
      if (event.type === 'message_delta' && event.usage) {
        metric.inputTokens = (metric.inputTokens ?? 0) + event.usage.input_tokens
        metric.outputTokens = (metric.outputTokens ?? 0) + event.usage.output_tokens
        metric.cacheCreationInputTokens =
          (metric.cacheCreationInputTokens ?? 0) + event.usage.cache_creation_input_tokens
        metric.cacheReadInputTokens =
          (metric.cacheReadInputTokens ?? 0) + event.usage.cache_read_input_tokens
      }
    },
  }).catch((error) => {
    metric.status = controller.signal.aborted ? 'aborted' : 'error'
    request.log.error({ err: error, generationId }, 'DeepSeek streaming request failed')
    if (!reply.sent && !reply.raw.headersSent) {
      errorResponse(reply, 502, 'DeepSeek request failed.')
    }
    return { status: metric.status }
  })
  metric.status = result.status === 'completed' ? 'completed' : result.status
  metric.durationMs = Math.max(0, Math.round(performance.now() - started))
  await pool
    .query(
      `UPDATE generations SET first_content_ms=$2,duration_ms=$3,generation_time_ms=$4,input_tokens=$5,output_tokens=$6,
      cache_creation_input_tokens=$7,cache_read_input_tokens=$8,context_window=$9,status=$10 WHERE id=$1`,
      [
        generationId,
        metric.firstContentMs,
        metric.durationMs,
        metric.generationTimeMs,
        metric.inputTokens,
        metric.outputTokens,
        metric.cacheCreationInputTokens,
        metric.cacheReadInputTokens,
        metric.contextWindow,
        metric.status,
      ]
    )
    .catch((error) =>
      request.log.error({ err: error, generationId }, 'Unable to store generation metrics')
    )
})

app.post('/api/anthropic/v1/files', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.', 'api_key_missing')
  }
  const part = await request.file()
  if (!part) {
    return errorResponse(reply, 400, 'No file was uploaded.')
  }
  const buffer = await part.toBuffer()
  const providerFile = await uploadDeepSeekFile(
    apiKey,
    { buffer, filename: part.filename, mimetype: part.mimetype },
    part.fields?.purpose?.value ?? null,
    request.raw.signal
  )
  const attachmentId = request.headers['x-attachment-id']
  if (typeof attachmentId === 'string' && validId(attachmentId)) {
    const storageKey = fileKey()
    const tempPath = path.join(UPLOAD_DIR, `${storageKey}.tmp`)
    const targetPath = path.join(UPLOAD_DIR, storageKey)
    await writeFile(tempPath, buffer, { mode: 0o600 })
    await rename(tempPath, targetPath)
    await pool.query(
      `INSERT INTO attachments(user_id,attachment_id,provider_file_id,filename,media_type,byte_size,storage_key)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id,attachment_id) DO UPDATE SET provider_file_id=EXCLUDED.provider_file_id,filename=EXCLUDED.filename,
        media_type=EXCLUDED.media_type,byte_size=EXCLUDED.byte_size,storage_key=EXCLUDED.storage_key,created_at=now()`,
      [
        request.chatUser.id,
        attachmentId,
        providerFile.id,
        part.filename,
        part.mimetype,
        buffer.length,
        storageKey,
      ]
    )
  }
  return providerFile
})

app.delete('/api/anthropic/v1/files/:fileId', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.')
  }
  await deleteDeepSeekFile(apiKey, request.params.fileId, request.raw.signal)
  return { ok: true }
})

app.get('/api/v1/sessions', async (request) => listSessions(request.chatUser.id))
app.get('/api/v1/sessions/:sessionId', async (request, reply) => {
  const session = await getSession(request.chatUser.id, request.params.sessionId)
  return session ? session.data : errorResponse(reply, 404, 'Session not found.')
})
app.put('/api/v1/sessions/:sessionId', async (request, reply) => {
  const sessionId = request.params.sessionId
  const session = request.body
  if (
    !validId(sessionId) ||
    !session ||
    typeof session !== 'object' ||
    session.id !== sessionId ||
    !Array.isArray(session.messages)
  ) {
    return errorResponse(reply, 400, 'Invalid session payload.')
  }
  const revision = await saveSession(request.chatUser.id, session)
  return { ok: true, revision }
})
app.patch('/api/v1/sessions/:sessionId', async (request, reply) => {
  const title = request.body?.title
  if (typeof title !== 'string' || title.length > 2000) {
    return errorResponse(reply, 400, 'Invalid session title.')
  }
  const current = await getSession(request.chatUser.id, request.params.sessionId)
  if (!current) {
    return errorResponse(reply, 404, 'Session not found.')
  }
  const next = { ...current.data, title }
  const revision = await saveSession(request.chatUser.id, next)
  return { ok: true, revision }
})
app.delete('/api/v1/sessions/:sessionId', async (request) => {
  const deleted = await deleteSession(request.chatUser.id, request.params.sessionId)
  if (deleted) {
    await cleanupUnusedAttachments(request.chatUser.id)
  }
  return { ok: deleted }
})
app.delete('/api/v1/sessions', async (request) => {
  const result = await pool.query('DELETE FROM chat_sessions WHERE user_id=$1', [
    request.chatUser.id,
  ])
  await cleanupUnusedAttachments(request.chatUser.id)
  return { ok: true, deleted: result.rowCount }
})
app.post('/api/v1/sessions/import', async (request, reply) => {
  const sessions = request.body?.sessions
  if (
    !Array.isArray(sessions) ||
    sessions.length > 1000 ||
    sessions.some(
      (session) => !session || typeof session.id !== 'string' || !Array.isArray(session.messages)
    )
  ) {
    return errorResponse(reply, 400, 'Invalid session import payload.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const session of sessions) {
      await client.query(
        `INSERT INTO chat_sessions(user_id,session_id,title,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT(user_id,session_id) DO UPDATE SET title=EXCLUDED.title,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,data=EXCLUDED.data,revision=chat_sessions.revision+1`,
        [
          request.chatUser.id,
          session.id,
          session.title ?? '',
          session.createdAt ?? Date.now(),
          session.updatedAt ?? Date.now(),
          JSON.stringify(session),
        ]
      )
    }
    await client.query('COMMIT')
    await cleanupUnusedAttachments(request.chatUser.id)
    return { ok: true, imported: sessions.length }
  } catch (error) {
    await client.query('ROLLBACK')
    request.log.error({ err: error }, 'Session import transaction failed')
    return errorResponse(reply, 500, 'Unable to import sessions.')
  } finally {
    client.release()
  }
})

app.post('/api/v1/sessions/replace', async (request, reply) => {
  const sessions = request.body?.sessions
  if (
    !Array.isArray(sessions) ||
    sessions.length > 1000 ||
    sessions.some(
      (session) => !session || typeof session.id !== 'string' || !Array.isArray(session.messages)
    )
  ) {
    return errorResponse(reply, 400, 'Invalid session replacement payload.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM chat_sessions WHERE user_id=$1', [request.chatUser.id])
    for (const session of sessions) {
      await client.query(
        'INSERT INTO chat_sessions(user_id,session_id,title,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          request.chatUser.id,
          session.id,
          session.title ?? '',
          session.createdAt ?? Date.now(),
          session.updatedAt ?? Date.now(),
          JSON.stringify(session),
        ]
      )
    }
    await client.query('COMMIT')
    await cleanupUnusedAttachments(request.chatUser.id)
    return { ok: true, imported: sessions.length }
  } catch (error) {
    await client.query('ROLLBACK')
    request.log.error({ err: error }, 'Session replacement transaction failed')
    return errorResponse(reply, 500, 'Unable to replace sessions.')
  } finally {
    client.release()
  }
})

app.put('/api/v1/attachments/:attachmentId', async (request, reply) => {
  const attachmentId = request.params.attachmentId
  if (!validId(attachmentId)) {
    return errorResponse(reply, 400, 'Invalid attachment ID.')
  }
  const part = await request.file()
  if (!part) {
    return errorResponse(reply, 400, 'No file was uploaded.')
  }
  const buffer = await part.toBuffer()
  const storageKey = fileKey()
  const tempPath = path.join(UPLOAD_DIR, `${storageKey}.tmp`)
  const targetPath = path.join(UPLOAD_DIR, storageKey)
  await writeFile(tempPath, buffer, { mode: 0o600 })
  await rename(tempPath, targetPath)
  const providerFileId = request.headers['x-provider-file-id']
  await pool.query(
    `INSERT INTO attachments(user_id,attachment_id,provider_file_id,filename,media_type,byte_size,storage_key)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_id,attachment_id) DO UPDATE SET provider_file_id=coalesce(EXCLUDED.provider_file_id,attachments.provider_file_id),
      filename=EXCLUDED.filename,media_type=EXCLUDED.media_type,byte_size=EXCLUDED.byte_size,storage_key=EXCLUDED.storage_key,created_at=now()`,
    [
      request.chatUser.id,
      attachmentId,
      typeof providerFileId === 'string' ? providerFileId : null,
      part.filename,
      part.mimetype,
      buffer.length,
      storageKey,
    ]
  )
  return { ok: true, attachmentId, size: buffer.length }
})

app.get('/api/v1/attachments/:attachmentId', async (request, reply) => {
  const { rows } = await pool.query(
    'SELECT filename,media_type,storage_key FROM attachments WHERE user_id=$1 AND attachment_id=$2',
    [request.chatUser.id, request.params.attachmentId]
  )
  const attachment = rows[0]
  if (!attachment) {
    return errorResponse(reply, 404, 'Attachment not found.')
  }
  const target = path.join(UPLOAD_DIR, path.basename(attachment.storage_key))
  reply
    .type(attachment.media_type)
    .header(
      'content-disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    )
  return reply.send(createReadStream(target))
})

async function getSessionMetrics(userId, sessionId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS generations,
      coalesce(sum(coalesce(input_tokens,0)+coalesce(cache_read_input_tokens,0)+coalesce(cache_creation_input_tokens,0)),0)::int AS prompt_tokens,
      coalesce(sum(output_tokens),0)::int AS output_tokens,
      coalesce(sum(cache_read_input_tokens),0)::int AS cache_read_input_tokens,
      coalesce(sum(cache_creation_input_tokens),0)::int AS cache_creation_input_tokens,
      avg(first_content_ms)::float AS avg_first_token_ms,
      avg(CASE WHEN output_tokens>0 AND generation_time_ms>0 THEN output_tokens*1000.0/generation_time_ms END) AS avg_tps,
      CASE WHEN coalesce(sum(coalesce(cache_read_input_tokens,0)+coalesce(input_tokens,0)+coalesce(cache_creation_input_tokens,0)),0)>0
        THEN sum(coalesce(cache_read_input_tokens,0))::float*100/coalesce(sum(coalesce(cache_read_input_tokens,0)+coalesce(input_tokens,0)+coalesce(cache_creation_input_tokens,0)),1)
        ELSE NULL END AS cache_hit_rate_pct,
      (SELECT coalesce(input_tokens,0)+coalesce(cache_read_input_tokens,0)+coalesce(cache_creation_input_tokens,0)
       FROM generations WHERE user_id=$1 AND session_id=$2 AND status='completed' ORDER BY started_at DESC LIMIT 1)::int AS current_prompt_tokens,
      (SELECT context_window FROM generations WHERE user_id=$1 AND session_id=$2 AND status='completed' ORDER BY started_at DESC LIMIT 1) AS context_window
     FROM generations WHERE user_id=$1 AND session_id=$2 AND status='completed'`,
    [userId, sessionId]
  )
  return rows[0]
}

app.get('/api/v1/metrics/sessions/:sessionId', async (request) =>
  getSessionMetrics(request.chatUser.id, request.params.sessionId)
)

app.post('/api/v1/dsh/pair-codes', async (request) => issuePairCode(request.chatUser.id))
app.post('/api/v1/dsh/pair', async (request, reply) => {
  const result = await redeemPairCode(request.body?.pairCode)
  return result ?? errorResponse(reply, 401, 'Pair code is invalid or expired.')
})
app.post('/api/v1/dsh/revoke', async (request, reply) => {
  if (!request.chatUser.tokenAuth || !request.chatUser.tokenHash) {
    return errorResponse(reply, 403, 'This endpoint requires a DSH bearer token.')
  }
  const { rowCount } = await pool.query(
    'DELETE FROM api_tokens WHERE user_id=$1 AND token_hash=$2',
    [request.chatUser.id, request.chatUser.tokenHash]
  )
  return { revoked: rowCount > 0 }
})
app.get('/api/v1/dsh/models', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.')
  }
  return [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      contextWindow: contextWindowFor('deepseek-flash'),
      maxTokens: 8192,
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: contextWindowFor('deepseek-v4-pro'),
      maxTokens: 8192,
    },
  ]
})

app.post('/api/v1/dsh/messages', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.')
  }
  const controller = new AbortController()
  request.raw.on('aborted', () => controller.abort(new Error('Client disconnected')))
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      controller.abort(new Error('Client disconnected'))
    }
  })
  try {
    await streamDeepSeekMessage({
      apiKey,
      body: request.body,
      signal: controller.signal,
      reply,
      onEvent() {},
    })
  } catch (error) {
    request.log.error({ err: error }, 'DSH Messages stream failed')
    if (!reply.raw.headersSent) {
      return errorResponse(reply, 502, 'DeepSeek request failed.')
    }
  }
})

const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_SKILL_FILES = 512
const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024
const MAX_SKILL_TOTAL_BYTES = 64 * 1024 * 1024

function normalizeSkillArchivePath(input) {
  const value = input.normalize('NFC').replaceAll('\\', '/')
  if (
    value.includes(String.fromCharCode(0)) ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value) ||
    value.split('/').some((part) => part === '..')
  ) {
    throw new Error('Skill ZIP contains an unsafe path.')
  }
  const parts = value.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part.startsWith('.') || part.toLowerCase() === 'node_modules')) {
    throw new Error('Skill ZIP contains a hidden or dependency path.')
  }
  return parts.join('/')
}

function inspectSkillArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error('Skill ZIP is empty or exceeds the 25 MB archive limit.')
  }
  const minimumOffset = Math.max(0, buffer.length - 65_557)
  let endRecord = -1
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) {
      continue
    }
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) {
      endRecord = offset
      break
    }
  }
  if (endRecord < 0) {
    throw new Error('Skill ZIP directory is invalid.')
  }
  if (
    buffer.readUInt16LE(endRecord + 4) !== 0 ||
    buffer.readUInt16LE(endRecord + 6) !== 0 ||
    buffer.readUInt16LE(endRecord + 8) !== buffer.readUInt16LE(endRecord + 10)
  ) {
    throw new Error('Multi-disk Skill ZIP files are not supported.')
  }
  const count = buffer.readUInt16LE(endRecord + 10)
  const centralSize = buffer.readUInt32LE(endRecord + 12)
  const centralOffset = buffer.readUInt32LE(endRecord + 16)
  if (
    count < 1 ||
    count > MAX_SKILL_FILES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Skill ZIP has too many files or uses an unsupported ZIP64 format.')
  }
  const centralEnd = centralOffset + centralSize
  if (centralOffset < 0 || centralEnd > endRecord || centralEnd < centralOffset) {
    throw new Error('Skill ZIP directory is out of bounds.')
  }
  const entries = []
  const seen = new Set()
  let totalSize = 0
  let cursor = centralOffset
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Skill ZIP directory entry is invalid.')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const compression = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const originalSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (
      end > centralEnd ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(compression) ||
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      originalSize > MAX_SKILL_FILE_BYTES
    ) {
      throw new Error('Skill ZIP contains an encrypted, oversized, or unsupported file.')
    }
    const fileType = (externalAttributes >>> 16) & 0xf000
    if (fileType === 0xa000) {
      throw new Error('Skill ZIP symlinks are not allowed.')
    }
    const rawPath = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    const isDirectory = rawPath.endsWith('/')
    const name = normalizeSkillArchivePath(rawPath)
    if (name && seen.has(name)) {
      throw new Error('Skill ZIP contains duplicate paths.')
    }
    if (name) {
      seen.add(name)
    }
    if (!isDirectory) {
      totalSize += originalSize
      if (totalSize > MAX_SKILL_TOTAL_BYTES) {
        throw new Error('Skill ZIP expands beyond the 64 MB limit.')
      }
      entries.push({ name, originalSize })
    }
    cursor = end
  }
  if (cursor > centralEnd) {
    throw new Error('Skill ZIP directory is invalid.')
  }
  return entries
}

function skillSlug(value) {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : ''
}

function skillMetadata(source, fallbackName) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  const metadata = match?.[1] ?? ''
  const field = (key) => {
    const prefix = `${key}:`
    const line = metadata
      .split(String.fromCharCode(10))
      .find((entry) => entry.trimStart().startsWith(prefix))
    if (!line) {
      return undefined
    }
    let value = line.slice(line.indexOf(':') + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    return value
  }
  const rawName = field('name')?.replace(/^['"]|['"]$/g, '') || fallbackName
  const rawDescription = field('description')?.replace(/^['"]|['"]$/g, '') || ''
  return {
    name: skillSlug(rawName),
    description: rawDescription.slice(0, 500),
    whenToUse: field('whenToUse')?.replace(/^['"]|['"]$/g, ''),
    content: match?.[2] ?? source,
  }
}

async function readSkillTextResources(root) {
  const allowedExtensions = new Set([
    '.md',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.py',
    '.js',
    '.ts',
    '.sh',
    '.toml',
  ])
  const resources = []
  let totalChars = 0
  const visit = async (directory, relative = '') => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await visit(path.join(directory, entry.name), rel)
        }
        continue
      }
      if (
        !entry.isFile() ||
        rel === 'SKILL.md' ||
        !allowedExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        continue
      }
      if (resources.length >= 12) {
        return
      }
      const filename = path.join(directory, entry.name)
      const info = await stat(filename).catch(() => null)
      if (!info || info.size > 24 * 1024) {
        continue
      }
      const text = await readFile(filename, 'utf8')
      if (totalChars + text.length > 64_000) {
        return
      }
      resources.push(`#### ${rel}\n${text}`)
      totalChars += text.length
    }
  }
  await visit(root)
  return resources
}

async function loadSkill(name, includeResources = false) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return null
  }
  const filename = path.join(SKILLS_DIR, name, 'SKILL.md')
  try {
    const source = await readFile(filename, 'utf8')
    const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
    const skillBody = match?.[2] ?? source
    const resources = includeResources ? await readSkillTextResources(path.dirname(filename)) : []
    const content = resources.length
      ? `${skillBody}\n\n## Imported Skill resources\n\n${resources.join('\n\n')}`
      : skillBody
    const metadata = match?.[1] ?? ''
    const field = (key) => {
      const prefix = `${key}:`
      const line = metadata
        .split(String.fromCharCode(10))
        .find((entry) => entry.trimStart().startsWith(prefix))
      if (!line) {
        return undefined
      }
      let value = line.slice(line.indexOf(':') + 1).trim()
      if (
        value.length >= 2 &&
        (value[0] === '"' || value[0] === "'") &&
        value.at(-1) === value[0]
      ) {
        value = value.slice(1, -1)
      }
      return value
    }
    return {
      name: field('name') ?? name,
      description: field('description') ?? '',
      whenToUse: field('whenToUse'),
      content,
      source: 'user-dsh',
      provider: 'chat-server',
    }
  } catch {
    return null
  }
}

async function listSkills() {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => [])
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const skill = await loadSkill(entry.name)
    if (skill) {
      skills.push({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: { modelInvocable: true, userInvocable: true },
        source: skill.source,
        provider: skill.provider,
      })
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

app.get('/api/v1/skills', async () => listSkills())
app.get(
  '/api/v1/skills/:name',
  async (request, reply) =>
    (await loadSkill(request.params.name, true)) ?? errorResponse(reply, 404, 'Skill not found.')
)
app.get('/api/v1/dsh/skills', async () => listSkills())
app.get(
  '/api/v1/dsh/skills/:name',
  async (request, reply) =>
    (await loadSkill(request.params.name, true)) ?? errorResponse(reply, 404, 'Skill not found.')
)

function setSkillDirectoryName(source, name) {
  const lines = source.split(String.fromCharCode(10))
  const opening = lines[0]?.trim() === '---'
  if (opening) {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (closing > 0) {
      const fields = lines.slice(1, closing).filter((line) => !line.trimStart().startsWith('name:'))
      fields.unshift(`name: ${name}`)
      return ['---', ...fields, '---', ...lines.slice(closing + 1)].join('\n')
    }
  }
  return `---\nname: ${name}\n---\n\n${source}`
}

app.post('/api/v1/skills/import', async (request, reply) => {
  const part = await request.file()
  if (!part) {
    return errorResponse(reply, 400, 'Choose a Skill folder to import.', 'skill_file_missing')
  }
  let stagingRoot
  const installed = []
  try {
    const archive = await part.toBuffer()
    const expectedEntries = inspectSkillArchive(archive)
    const expectedSizes = new Map(expectedEntries.map((entry) => [entry.name, entry.originalSize]))
    const unzipped = unzipSync(archive)
    const entries = []
    let extractedBytes = 0
    for (const [rawPath, data] of Object.entries(unzipped)) {
      if (rawPath.endsWith('/')) {
        continue
      }
      const name = normalizeSkillArchivePath(rawPath)
      const expectedSize = expectedSizes.get(name)
      if (!name || expectedSize === undefined || data.byteLength !== expectedSize) {
        throw new Error('Skill ZIP contents do not match its directory.')
      }
      extractedBytes += data.byteLength
      if (extractedBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error('Skill ZIP expands beyond the 64 MB limit.')
      }
      entries.push({ name, data: Buffer.from(data) })
    }

    const manifestEntries = entries.filter(({ name }) => path.posix.basename(name) === 'SKILL.md')
    if (manifestEntries.length === 0) {
      return errorResponse(
        reply,
        400,
        'No SKILL.md file was found in the selected folder.',
        'skill_folder_missing_manifest'
      )
    }
    if (
      manifestEntries.length > 1 &&
      manifestEntries.some(({ name }) => path.posix.dirname(name) === '.')
    ) {
      return errorResponse(
        reply,
        400,
        'Place each SKILL.md in its own folder before importing.',
        'skill_folder_ambiguous'
      )
    }

    const plans = []
    const usedNames = new Set()
    for (let index = 0; index < manifestEntries.length; index += 1) {
      const manifestEntry = manifestEntries[index]
      const root =
        path.posix.dirname(manifestEntry.name) === '.' ? '' : path.posix.dirname(manifestEntry.name)
      const folderName = path.posix.basename(root || part.filename.replace(/\.zip$/i, ''))
      const parsed = skillMetadata(manifestEntry.data.toString('utf8'), folderName)
      const name = skillSlug(parsed.name) || skillSlug(folderName) || `skill-${index + 1}`
      if (usedNames.has(name)) {
        return errorResponse(reply, 409, `Duplicate Skill name: ${name}.`, 'skill_name_duplicate')
      }
      usedNames.add(name)
      const files = []
      for (const entry of entries) {
        if (root && !entry.name.startsWith(`${root}/`)) {
          continue
        }
        const relative = root ? entry.name.slice(root.length + 1) : entry.name
        if (!relative || relative.split('/').some((segment) => segment === '..')) {
          continue
        }
        files.push({
          relative,
          data:
            relative === 'SKILL.md'
              ? Buffer.from(setSkillDirectoryName(entry.data.toString('utf8'), name))
              : entry.data,
        })
      }
      if (!files.some((file) => file.relative === 'SKILL.md')) {
        continue
      }
      plans.push({ name, description: parsed.description, files })
    }
    if (plans.length === 0) {
      return errorResponse(reply, 400, 'No usable Skill folders were found.', 'skill_folder_empty')
    }

    for (const plan of plans) {
      try {
        await access(path.join(SKILLS_DIR, plan.name))
        return errorResponse(
          reply,
          409,
          `Skill "${plan.name}" already exists; remove it before re-importing.`,
          'skill_already_exists'
        )
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
      }
    }

    stagingRoot = await mkdtemp(path.join(SKILLS_DIR, '.import-'))
    for (const plan of plans) {
      const skillDirectory = path.join(stagingRoot, plan.name)
      for (const file of plan.files) {
        const target = path.resolve(skillDirectory, ...file.relative.split('/'))
        if (!target.startsWith(`${path.resolve(skillDirectory)}${path.sep}`)) {
          throw new Error('Skill ZIP contains an unsafe relative path.')
        }
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.data, { mode: 0o600 })
      }
    }
    for (const plan of plans) {
      const destination = path.join(SKILLS_DIR, plan.name)
      await rename(path.join(stagingRoot, plan.name), destination)
      installed.push(destination)
    }
    return { ok: true, imported: plans.map(({ name, description }) => ({ name, description })) }
  } catch (error) {
    for (const directory of installed) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
    request.log.warn({ err: error }, 'Skill folder import failed')
    return errorResponse(
      reply,
      400,
      error instanceof Error ? error.message : 'Skill folder import failed.',
      'skill_folder_import_failed'
    )
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
})

app.post('/api/v1/skills', async (request, reply) => {
  const { name, description, whenToUse, content } = request.body ?? {}
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    typeof content !== 'string' ||
    content.length > 250_000
  ) {
    return errorResponse(reply, 400, 'Skill name or content is invalid.')
  }
  const directory = path.join(SKILLS_DIR, name)
  await mkdir(directory, { recursive: true })
  const frontmatter = `---\nname: ${name}\ndescription: ${JSON.stringify(typeof description === 'string' ? description : '')}\n${typeof whenToUse === 'string' ? `whenToUse: ${JSON.stringify(whenToUse)}\n` : ''}---\n\n`
  await writeFile(path.join(directory, 'SKILL.md'), frontmatter + content, { mode: 0o600 })
  return { ok: true, name }
})

app.delete('/api/v1/skills/:name', async (request, reply) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.params.name)) {
    return errorResponse(reply, 400, 'Invalid skill name.')
  }
  const { rm } = await import('node:fs/promises')
  await rm(path.join(SKILLS_DIR, request.params.name), { recursive: true, force: true })
  return { ok: true }
})

app.post('/api/v1/mcp/servers', async (request, reply) => {
  try {
    const server = await saveMcpServer(request.chatUser.id, request.body)
    return { ok: true, server }
  } catch (error) {
    return errorResponse(
      reply,
      400,
      error instanceof Error ? error.message : 'Invalid MCP server configuration.'
    )
  }
})

app.get('/api/v1/mcp/servers', async (request) => listMcpServers(request.chatUser.id))

app.post('/api/v1/mcp/servers/:id/probe', async (request, reply) => {
  try {
    return await probeMcpServer(request.chatUser.id, request.params.id, request.raw.signal)
  } catch (error) {
    return errorResponse(reply, 502, error instanceof Error ? error.message : 'MCP probe failed.')
  }
})

app.get('/api/v1/mcp/tools', async (request, reply) => {
  try {
    return await listMcpTools(request.chatUser.id, true)
  } catch (error) {
    return errorResponse(
      reply,
      502,
      error instanceof Error ? error.message : 'MCP tool discovery failed.'
    )
  }
})

app.post('/api/v1/mcp/tools/call', async (request, reply) => {
  try {
    return await callMcpTool(
      request.chatUser.id,
      request.body?.qualifiedName,
      request.body?.args ?? {},
      request.raw.signal
    )
  } catch (error) {
    return errorResponse(
      reply,
      502,
      error instanceof Error ? error.message : 'MCP tool call failed.'
    )
  }
})

app.patch('/api/v1/mcp/servers/:id', async (request, reply) => {
  if (typeof request.body?.enabled !== 'boolean') {
    return errorResponse(reply, 400, 'enabled must be boolean.')
  }
  const { rowCount } = await pool.query(
    'UPDATE mcp_servers SET enabled=$3,updated_at=now() WHERE user_id=$1 AND server_id=$2',
    [request.chatUser.id, request.params.id, request.body.enabled]
  )
  return rowCount
    ? { ok: true, enabled: request.body.enabled }
    : errorResponse(reply, 404, 'MCP server not found.')
})

app.delete('/api/v1/mcp/servers/:id', async (request, reply) => {
  const removed = await deleteMcpServer(request.chatUser.id, request.params.id)
  return removed ? { ok: true } : errorResponse(reply, 404, 'MCP server not found.')
})

app.get('/api/v1/metrics/sessions/:sessionId/summary', async (request) =>
  getSessionMetrics(request.chatUser.id, request.params.sessionId)
)

app.post('/api/v1/tools/asr', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.')
  }
  const part = await request.file()
  if (!part) {
    return errorResponse(reply, 400, 'No audio file was uploaded.')
  }
  return transcribeDeepSeek(
    apiKey,
    { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype },
    request.raw.signal
  )
})

app.post('/api/v1/tools/tts', async (request, reply) => {
  const apiKey = await getDeepSeekApiKey(request.chatUser.id)
  if (!apiKey) {
    return errorResponse(reply, 400, 'Configure a DeepSeek API Key first.')
  }
  const stream = await synthesizeDeepSeek(apiKey, request.body, request.raw.signal)
  reply.type('application/octet-stream').header('cache-control', 'no-store')
  return reply.send(Readable.fromWeb(stream))
})

const distDir = path.join(ROOT, 'dist')
await mkdir(distDir, { recursive: true })
await app.register(fastifyStatic, {
  root: distDir,
  prefix: '/',
  decorateReply: false,
  wildcard: true,
})
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    return errorResponse(reply, 404, 'API route not found.')
  }
  if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
    try {
      return reply.type('text/html').send(await readFile(path.join(distDir, 'index.html')))
    } catch {
      /* Build frontend first. */
    }
  }
  return errorResponse(reply, 404, 'Not found.')
})

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
await app.listen({ port, host })
