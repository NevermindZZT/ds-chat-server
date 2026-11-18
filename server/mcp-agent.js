import { streamDeepSeekMessage } from './deepseek.js'
import { callMcpTool, listMcpTools } from './mcp.js'

const API_ORIGIN = 'https://api.deepseek.com'
const FILES_BETA = 'files-api-2025-04-14'
const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_ERROR_CHARS = 4_000
const MAX_ERROR_EVENT_CHARS = 8_192
const MCP_ACTIVITY_INDEX_START = 1_000_000
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const LINE_BREAK = /\r\n|\r|\n/g

const deepseekHeaders = (apiKey, extra = {}) => ({
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  ...extra,
})

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isPlainObject = (value) => {
  if (!isRecord(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A WHATWG-style parser for the named SSE frames returned by DeepSeek Messages. */
class SseDecoder {
  buffer = ''
  data = []
  eventName = ''

  push(text) {
    this.buffer += text
    const frames = []
    let lineStart = 0
    LINE_BREAK.lastIndex = 0

    for (let match = LINE_BREAK.exec(this.buffer); match; match = LINE_BREAK.exec(this.buffer)) {
      // A trailing CR may be the first half of CRLF in the next network chunk.
      if (match[0] === '\r' && LINE_BREAK.lastIndex === this.buffer.length) {
        break
      }
      const frame = this.processLine(this.buffer.slice(lineStart, match.index))
      if (frame) {
        frames.push(frame)
      }
      lineStart = LINE_BREAK.lastIndex
    }

    this.buffer = this.buffer.slice(lineStart)
    return frames
  }

  end() {
    const frames = []
    if (this.buffer.endsWith('\r')) {
      const frame = this.processLine(this.buffer.slice(0, -1))
      if (frame) {
        frames.push(frame)
      }
    }
    // Per SSE, a final event without its terminating blank line is not dispatched.
    this.buffer = ''
    this.data = []
    this.eventName = ''
    return frames
  }

  processLine(line) {
    if (line === '') {
      return this.dispatch()
    }
    if (line.startsWith(':')) {
      return null
    }

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }

    if (field === 'data') {
      this.data.push(value)
    } else if (field === 'event') {
      this.eventName = value
    }
    return null
  }

  dispatch() {
    if (this.data.length === 0) {
      this.eventName = ''
      return null
    }
    const frame = { event: this.eventName || 'message', data: this.data.join('\n') }
    this.data = []
    this.eventName = ''
    return frame
  }
}

async function* readSseEvents(stream, signal) {
  const reader = stream.getReader()
  const decoder = new SseDecoder()
  const textDecoder = new TextDecoder()
  let finished = false
  const cancel = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })

  try {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('DeepSeek request aborted.')
      }
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        if (signal?.aborted) {
          throw signal.reason ?? new Error('DeepSeek request aborted.')
        }
        yield* decoder.push(textDecoder.decode())
        yield* decoder.end()
        return
      }
      yield* decoder.push(textDecoder.decode(value, { stream: true }))
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!finished) {
      reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

function callMetrics(onEvent, event) {
  if (typeof onEvent !== 'function') {
    return
  }
  try {
    Promise.resolve(onEvent(event)).catch(() => {})
  } catch {
    // Metrics must not interrupt model or MCP execution.
  }
}

function safeApiToolName(index, qualifiedName, reservedNames) {
  const prefix = `mcp_${index}_`
  const slug = qualifiedName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128 - prefix.length) || 'tool'
  const base = `${prefix}${slug}`
  let name = base
  let collision = 1
  while (reservedNames.has(name)) {
    const suffix = `_${collision}`
    name = `${base.slice(0, 128 - suffix.length)}${suffix}`
    collision += 1
  }
  reservedNames.add(name)
  return name
}

function makeMcpToolBindings(mcpTools, originalTools) {
  const reservedNames = new Set(
    originalTools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
  )
  const apiTools = []
  const qualifiedNames = new Map()

  for (const [index, tool] of mcpTools.entries()) {
    if (!tool || typeof tool.qualifiedName !== 'string' || !tool.qualifiedName) {
      continue
    }

    const name = safeApiToolName(index, tool.qualifiedName, reservedNames)
    apiTools.push({
      name,
      description:
        typeof tool.description === 'string'
          ? tool.description
          : typeof tool.title === 'string'
            ? tool.title
            : '',
      input_schema: isPlainObject(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    })
    qualifiedNames.set(name, tool.qualifiedName)
  }

  return { apiTools, qualifiedNames }
}

function appendBlockDelta(block, delta) {
  if (block.type === 'text' && delta.type === 'text_delta') {
    block.text = `${block.text ?? ''}${delta.text}`
  } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
    block.thinking = `${block.thinking ?? ''}${delta.thinking}`
  } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
    block.signature = `${block.signature ?? ''}${delta.signature}`
  } else if (block.type === 'text' && delta.type === 'citations_delta') {
    block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation]
  }
}

function finalizeToolUse(state) {
  const block = { ...state.block }
  let input = block.input
  let inputError

  if (state.partialJson.length > 0) {
    try {
      input = JSON.parse(state.partialJson)
    } catch {
      input = {}
      inputError = 'The model returned malformed JSON arguments for this MCP tool.'
    }
  }
  if (!isPlainObject(input)) {
    input = {}
    inputError ??= 'MCP tool arguments must be a JSON object.'
  }
  block.input = input
  state.block = block

  return {
    block,
    inputError,
  }
}

function assistantBlocks(blockStates) {
  return [...blockStates.values()]
    .sort((left, right) => left.index - right.index)
    .map((state) => state.block)
}

function toolErrorResult(toolUse, message) {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.block.id,
    is_error: true,
    content: [{ type: 'text', text: String(message).slice(0, MAX_TOOL_ERROR_CHARS) }],
  }
}

function serializeMcpContentBlock(block) {
  if (!isRecord(block)) {
    return { type: 'text', text: JSON.stringify(block) }
  }
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  if (
    block.type === 'image' &&
    typeof block.data === 'string' &&
    IMAGE_MEDIA_TYPES.has(block.mimeType)
  ) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mimeType, data: block.data },
    }
  }
  if (block.type === 'resource' && isRecord(block.resource)) {
    if (typeof block.resource.text === 'string') {
      return {
        type: 'text',
        text: `Resource ${String(block.resource.uri ?? '')}:\n${block.resource.text}`,
      }
    }
    return {
      type: 'text',
      text: JSON.stringify({
        type: block.type,
        uri: block.resource.uri,
        mimeType: block.resource.mimeType,
      }),
    }
  }
  // Audio and future MCP content types are not Messages content blocks; preserve their
  // available metadata as data instead of pretending they are a model-generated answer.
  return { type: 'text', text: JSON.stringify(block) }
}

function toolResultContent(result) {
  const content = Array.isArray(result?.content) ? result.content.map(serializeMcpContentBlock) : []
  if (isPlainObject(result?.structuredContent)) {
    content.push({
      type: 'text',
      text: `structuredContent: ${JSON.stringify(result.structuredContent)}`,
    })
  }
  return content
}

function toolResultBlock(toolUse, result) {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.block.id,
    ...(result?.isError === true ? { is_error: true } : {}),
    content: toolResultContent(result),
  }
}

async function writeRaw(raw, text, signal) {
  if (!raw.writable) {
    throw new Error('Client connection is closed.')
  }
  if (raw.write(text)) {
    return
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      raw.removeListener('drain', onDrain)
      raw.removeListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Client connection is closed.'))
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('DeepSeek request aborted.'))
    }
    raw.once('drain', onDrain)
    raw.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function encodeSseFrame(eventName, data) {
  const lines = []
  if (eventName && eventName !== 'message') {
    lines.push(`event: ${eventName}`)
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  for (const line of text.split(/\r\n|\r|\n/)) {
    lines.push(`data: ${line}`)
  }
  return `${lines.join('\n')}\n\n`
}

async function writeSseFrame(raw, eventName, data, signal) {
  await writeRaw(raw, encodeSseFrame(eventName, data), signal)
}

function beginBrowserStream(reply, upstream) {
  const requestId = upstream.headers.get('x-ds-request-id')
  reply.hijack()
  reply.raw.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(requestId ? { 'x-ds-request-id': requestId } : {}),
  })
}

async function openDeepSeekStream(apiKey, body, signal) {
  const hasFiles = body.messages?.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block?.type === 'image' || block?.type === 'document')
  )
  const response = await fetch(`${API_ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: deepseekHeaders(apiKey, {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(hasFiles ? { 'anthropic-beta': FILES_BETA } : {}),
    }),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '')
    return {
      error: {
        status: response.status || 502,
        message:
          errorText ||
          (response.body ? 'DeepSeek request failed.' : 'DeepSeek returned an empty stream.'),
      },
    }
  }
  return { response }
}

async function sendPreStreamError(reply, status, message, code) {
  reply.code(status).type('application/json').send({ error: { message, code } })
}

async function sendStreamError(reply, message, signal) {
  if (signal?.aborted) {
    if (reply.raw.writable) {
      reply.raw.end()
    }
    return
  }
  if (!reply.raw.writable) {
    return
  }
  const safeMessage = String(message).slice(0, MAX_ERROR_EVENT_CHARS)
  try {
    await writeSseFrame(reply.raw, 'error', {
      type: 'error',
      error: { type: 'api_error', message: safeMessage },
    })
  } catch {
    // The browser may disconnect while the error is being sent.
  }
  if (reply.raw.writable) {
    reply.raw.end()
  }
}

async function streamOneRound({
  apiKey,
  body,
  signal,
  reply,
  onEvent,
  startBrowserStream,
  includeMcpTools,
}) {
  const opened = await openDeepSeekStream(apiKey, body, signal)
  if (opened.error) {
    return { error: opened.error }
  }
  const upstream = opened.response
  if (startBrowserStream()) {
    beginBrowserStream(reply, upstream)
  }

  const blockStates = new Map()
  let stopReason
  let receivedMessageStop = false
  let apiError

  try {
    for await (const frame of readSseEvents(upstream.body, signal)) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('DeepSeek request aborted.')
      }

      let event
      try {
        event = JSON.parse(frame.data)
      } catch {
        await writeSseFrame(reply.raw, frame.event, frame.data, signal)
        continue
      }
      callMetrics(onEvent, event)

      if (frame.event === 'error' || event.type === 'error' || (event.error && !event.type)) {
        await writeSseFrame(reply.raw, frame.event, event, signal)
        apiError = event.error?.message ?? 'DeepSeek streaming request failed.'
        break
      }

      switch (event.type) {
        case 'content_block_start': {
          if (!Number.isSafeInteger(event.index) || !isRecord(event.content_block)) {
            await writeSseFrame(reply.raw, frame.event, event, signal)
            break
          }
          const block = { ...event.content_block }
          const state = {
            index: event.index,
            block,
            partialJson: '',
            suppressed: block.type === 'tool_use',
            inputError: undefined,
          }
          blockStates.set(event.index, state)
          if (block.type === 'tool_use') {
            if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string') {
              state.inputError = 'The model returned an invalid MCP tool call.'
            }
          } else {
            await writeSseFrame(reply.raw, frame.event, event, signal)
          }
          break
        }
        case 'content_block_delta': {
          const state = blockStates.get(event.index)
          if (state && isRecord(event.delta)) {
            if (state.block.type === 'tool_use' && event.delta.type === 'input_json_delta') {
              if (typeof event.delta.partial_json === 'string') {
                state.partialJson += event.delta.partial_json
              } else {
                state.inputError = 'The model returned invalid JSON for this MCP tool.'
              }
            } else {
              appendBlockDelta(state.block, event.delta)
            }
            if (state.suppressed) {
              break
            }
          }
          await writeSseFrame(reply.raw, frame.event, event, signal)
          break
        }
        case 'content_block_stop': {
          const state = blockStates.get(event.index)
          if (state?.block.type === 'tool_use') {
            const toolUse = finalizeToolUse(state)
            toolUse.inputError ??= state.inputError
            if (typeof toolUse.block.id !== 'string' || !toolUse.block.id) {
              apiError = 'The model returned an MCP tool call without a valid ID.'
              break
            }
          } else {
            await writeSseFrame(reply.raw, frame.event, event, signal)
          }
          break
        }
        case 'message_delta':
          stopReason = event.delta?.stop_reason
          // Internal client-tool turns are not displayed as completed answers.
          if (stopReason !== 'tool_use') {
            await writeSseFrame(reply.raw, frame.event, event, signal)
          }
          break
        case 'message_stop': {
          receivedMessageStop = true
          const hasToolUse = [...blockStates.values()].some(
            (state) => state.block.type === 'tool_use'
          )
          if (stopReason !== 'tool_use' || !hasToolUse) {
            await writeSseFrame(reply.raw, frame.event, event, signal)
          }
          break
        }
        default:
          await writeSseFrame(reply.raw, frame.event, event, signal)
          break
      }

      if (apiError || receivedMessageStop) {
        break
      }
    }
  } finally {
    if (signal?.aborted) {
      await upstream.body.cancel(signal.reason).catch(() => {})
    }
  }

  if (apiError) {
    return { error: { status: 502, message: String(apiError) } }
  }
  if (!receivedMessageStop) {
    return { error: { status: 502, message: 'DeepSeek stream ended before message_stop.' } }
  }

  const toolStates = [...blockStates.values()].filter((state) => state.block.type === 'tool_use')
  const roundToolUses = toolStates.map((state) => {
    const toolUse = finalizeToolUse(state)
    toolUse.inputError ??= state.inputError
    return toolUse
  })
  const blocks = assistantBlocks(blockStates)
  if (roundToolUses.some((toolUse) => typeof toolUse.block.id !== 'string' || !toolUse.block.id)) {
    return {
      error: { status: 502, message: 'The model returned an MCP tool call without a valid ID.' },
    }
  }

  if (stopReason === 'tool_use' && roundToolUses.length > 0) {
    return {
      toolUseRound: true,
      assistantContent: blocks,
      toolUses: roundToolUses,
      includeMcpTools,
    }
  }

  return { completed: true, stopReason }
}

async function runToolCalls({ userId, toolUses, qualifiedNames, signal, mayExecute }) {
  const results = []
  for (const toolUse of toolUses) {
    if (toolUse.inputError) {
      results.push(toolErrorResult(toolUse, toolUse.inputError))
      continue
    }

    const qualifiedName = qualifiedNames.get(toolUse.block.name)
    if (!qualifiedName) {
      results.push(
        toolErrorResult(
          toolUse,
          'This MCP tool is not enabled or is not available for this request. No tool was executed.'
        )
      )
      continue
    }
    if (!mayExecute) {
      results.push(
        toolErrorResult(
          toolUse,
          `The maximum of ${MAX_TOOL_ROUNDS} MCP tool rounds was reached. No additional tool was executed.`
        )
      )
      continue
    }
    if (signal?.aborted) {
      throw signal.reason ?? new Error('MCP tool call aborted.')
    }

    try {
      const result = await callMcpTool(userId, qualifiedName, toolUse.block.input, signal)
      results.push(toolResultBlock(toolUse, result))
    } catch (error) {
      results.push(
        toolErrorResult(
          toolUse,
          error instanceof Error ? error.message : 'The MCP tool call failed.'
        )
      )
    }
  }
  return results
}

async function writeMcpActivityBlocks({
  reply,
  toolUses,
  toolResults,
  qualifiedNames,
  tools,
  signal,
  firstIndex,
}) {
  const byQualifiedName = new Map(tools.map((tool) => [tool.qualifiedName, tool]))
  for (let index = 0; index < toolUses.length; index += 1) {
    const toolUse = toolUses[index]
    const qualifiedName = qualifiedNames.get(toolUse.block.name)
    const metadata = qualifiedName ? byQualifiedName.get(qualifiedName) : undefined
    await writeSseFrame(
      reply.raw,
      'message',
      {
        type: 'content_block_start',
        index: firstIndex + index,
        content_block: {
          type: 'mcp_tool_activity',
          id: toolUse.block.id,
          serverName: metadata?.serverName ?? metadata?.serverId ?? 'MCP server',
          toolName: metadata?.name ?? qualifiedName ?? toolUse.block.name,
          status: toolResults[index]?.is_error === true ? 'error' : 'done',
        },
      },
      signal
    )
    await writeSseFrame(
      reply.raw,
      'message',
      { type: 'content_block_stop', index: firstIndex + index },
      signal
    )
  }
}

/**
 * Streams a DeepSeek Messages request with enabled MCP tools and a bounded client-tool loop.
 *
 * DeepSeek server-side tools and normal thinking/text/citation events are forwarded unchanged.
 * Internal MCP tool blocks and intermediate tool-use message_stop events are withheld from the
 * browser; only the final model response emits message_stop. MCP errors are returned to the model
 * as paired is_error tool_result blocks so it can recover without fabricated answer content.
 *
 * @param {object} options
 * @param {string} options.apiKey - DeepSeek API key.
 * @param {object} options.body - Anthropic-compatible Messages request body.
 * @param {AbortSignal} [options.signal] - Cancellation signal for fetches and MCP calls.
 * @param {import('fastify').FastifyReply} options.reply - Fastify reply to stream to.
 * @param {string} options.userId - Authenticated user whose enabled MCP tools may be used.
 * @param {(event: object) => void} [options.onEvent] - Best-effort callback for every parsed DeepSeek SSE event, including internal tool rounds.
 * @returns {Promise<{status: 'completed' | 'aborted' | 'error'}>}
 */
export async function streamDeepSeekWithMcp({ apiKey, body, signal, reply, userId, onEvent }) {
  if (signal?.aborted) {
    return { status: 'aborted' }
  }

  let mcpTools
  try {
    mcpTools = await listMcpTools(userId, true)
  } catch (error) {
    if (signal?.aborted) {
      return { status: 'aborted' }
    }
    await sendPreStreamError(
      reply,
      502,
      error instanceof Error
        ? `MCP tool discovery failed: ${error.message}`
        : 'MCP tool discovery failed.',
      'mcp_tool_discovery_failed'
    )
    return { status: 'error' }
  }
  if (signal?.aborted) {
    return { status: 'aborted' }
  }

  if (!Array.isArray(mcpTools) || mcpTools.length === 0) {
    return streamDeepSeekMessage({ apiKey, body, signal, reply, onEvent })
  }

  const originalTools = Array.isArray(body?.tools) ? body.tools : []
  const { apiTools, qualifiedNames } = makeMcpToolBindings(mcpTools, originalTools)
  if (apiTools.length === 0) {
    return streamDeepSeekMessage({ apiKey, body, signal, reply, onEvent })
  }

  const baseMessages = Array.isArray(body?.messages) ? body.messages : []
  const messages = [...baseMessages]
  let toolRounds = 0
  let recoveryAfterLimitUsed = false
  let includeMcpTools = true
  let streamStarted = false
  let activityIndex = MCP_ACTIVITY_INDEX_START

  for (;;) {
    if (signal?.aborted) {
      if (streamStarted && reply.raw.writable) {
        reply.raw.end()
      }
      return { status: 'aborted' }
    }

    const requestBody = {
      ...body,
      messages,
      tools: includeMcpTools ? [...originalTools, ...apiTools] : originalTools,
      stream: true,
    }

    let round
    try {
      round = await streamOneRound({
        apiKey,
        body: requestBody,
        signal,
        reply,
        onEvent,
        includeMcpTools,
        startBrowserStream: () => {
          if (streamStarted) {
            return false
          }
          streamStarted = true
          return true
        },
      })
    } catch (error) {
      if (signal?.aborted) {
        if (streamStarted && reply.raw.writable) {
          reply.raw.end()
        }
        return { status: 'aborted' }
      }
      if (streamStarted) {
        await sendStreamError(
          reply,
          error instanceof Error ? error.message : 'DeepSeek request failed.',
          signal
        )
      } else {
        await sendPreStreamError(
          reply,
          502,
          error instanceof Error ? error.message : 'DeepSeek request failed.',
          'deepseek_request_failed'
        )
      }
      return { status: 'error' }
    }

    if (round.error) {
      if (streamStarted) {
        await sendStreamError(reply, round.error.message, signal)
      } else {
        await sendPreStreamError(
          reply,
          round.error.status,
          round.error.message,
          'deepseek_request_failed'
        )
      }
      return { status: 'error' }
    }

    if (!round.toolUseRound) {
      if (reply.raw.writable) {
        reply.raw.end()
      }
      return { status: 'completed' }
    }

    messages.push({ role: 'assistant', content: round.assistantContent })
    toolRounds += 1
    const mayExecute = toolRounds <= MAX_TOOL_ROUNDS && includeMcpTools
    let toolResults
    try {
      toolResults = await runToolCalls({
        userId,
        toolUses: round.toolUses,
        qualifiedNames,
        signal,
        mayExecute,
      })
    } catch (error) {
      if (signal?.aborted) {
        if (reply.raw.writable) {
          reply.raw.end()
        }
        return { status: 'aborted' }
      }
      toolResults = round.toolUses.map((toolUse) =>
        toolErrorResult(
          toolUse,
          error instanceof Error ? error.message : 'The MCP tool call failed.'
        )
      )
    }
    await writeMcpActivityBlocks({
      reply,
      toolUses: round.toolUses,
      toolResults,
      qualifiedNames,
      tools: mcpTools,
      signal,
      firstIndex: activityIndex,
    })
    activityIndex += round.toolUses.length
    messages.push({ role: 'user', content: toolResults })

    if (toolRounds >= MAX_TOOL_ROUNDS) {
      includeMcpTools = false
    }
    if (!includeMcpTools && !mayExecute) {
      // One bounded recovery request lets the model explain tool failures/limits. It cannot
      // execute more MCP tools; if it asks again, return an error rather than inventing content.
      if (recoveryAfterLimitUsed) {
        await sendStreamError(reply, 'MCP tool round limit reached before a final answer.', signal)
        return { status: 'error' }
      }
      recoveryAfterLimitUsed = true
    }
  }
}
