const API_ORIGIN = 'https://api.deepseek.com'
const FILES_BETA = 'files-api-2025-04-14'

const deepseekHeaders = (apiKey, extra = {}) => ({
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  ...extra,
})

export async function verifyDeepSeekKey(apiKey, signal) {
  const response = await fetch(`${API_ORIGIN}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || `DeepSeek API returned ${response.status}`)
  }
}

export async function uploadDeepSeekFile(apiKey, file, purpose, signal) {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.filename)
  const response = await fetch(`${API_ORIGIN}/anthropic/v1/files`, {
    method: 'POST',
    headers: deepseekHeaders(apiKey, { 'anthropic-beta': FILES_BETA }),
    body: form,
    signal,
  })
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `DeepSeek API returned ${response.status}`))
  }
  return response.json()
}

export async function deleteDeepSeekFile(apiKey, fileId, signal) {
  const response = await fetch(`${API_ORIGIN}/anthropic/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: deepseekHeaders(apiKey, { 'anthropic-beta': FILES_BETA }),
    signal,
  })
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `DeepSeek API returned ${response.status}`))
  }
}

function parseSseEvents(buffer, onEvent) {
  let boundary
  while ((boundary = buffer.indexOf('\n\n')) >= 0) {
    const packet = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const data = packet
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') {
      continue
    }
    try {
      onEvent(JSON.parse(data))
    } catch {
      /* Preserve malformed upstream frames for the browser; metrics are best-effort. */
    }
  }
  return buffer
}

export async function streamDeepSeekMessage({ apiKey, body, signal, reply, onEvent }) {
  const hasFiles = body.messages?.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )
  const upstream = await fetch(`${API_ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: deepseekHeaders(apiKey, {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(hasFiles ? { 'anthropic-beta': FILES_BETA } : {}),
    }),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text().catch(() => '')
    reply
      .code(upstream.status || 502)
      .type('application/json')
      .send({ error: { message: errorText || 'DeepSeek request failed.' } })
    return { status: 'error' }
  }

  reply.hijack()
  reply.raw.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(upstream.headers.get('x-ds-request-id')
      ? { 'x-ds-request-id': upstream.headers.get('x-ds-request-id') }
      : {}),
  })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  let ended = false
  try {
    while (!ended) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      const chunk = Buffer.from(value)
      reply.raw.write(chunk)
      carry += decoder.decode(value, { stream: true })
      carry = parseSseEvents(carry, onEvent)
      ended = !reply.raw.writable
    }
    carry += decoder.decode()
    parseSseEvents(carry, onEvent)
    if (reply.raw.writable) {
      reply.raw.end()
    }
    return { status: signal.aborted ? 'aborted' : 'completed' }
  } catch (error) {
    if (reply.raw.writable) {
      reply.raw.destroy(error)
    }
    throw error
  } finally {
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => {})
    }
  }
}

export async function completeDeepSeekMessage(apiKey, body, signal) {
  const response = await fetch(`${API_ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: deepseekHeaders(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  })
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `DeepSeek API returned ${response.status}`))
  }
  const result = await response.json()
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\\n')
    .trim()
}

export async function transcribeDeepSeek(apiKey, file, signal) {
  const form = new FormData()
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.filename)
  const response = await fetch(`${API_ORIGIN}/v1/tools/asr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `DeepSeek API returned ${response.status}`))
  }
  return response.json()
}

export async function synthesizeDeepSeek(apiKey, body, signal) {
  const response = await fetch(`${API_ORIGIN}/v1/tools/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(await response.text().catch(() => `DeepSeek API returned ${response.status}`))
  }
  return response.body
}
