import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { apply } from '../index.js'

test('plugin settings use valid credential keys and preserve pairing on toggle', async () => {
  const records = new Map()
  const tokenKey = 'dsh-chat-server/access-token'
  let handler
  const ctx = {
    llm: { registerAdapter() {} },
    credentials: {
      async readRecord(key) {
        parseCredentialKey(key)
        return records.get(key)
      },
      async modifyRecord(key, fn) {
        parseCredentialKey(key)
        const value = await fn(records.get(key))
        records.set(key, value)
        return value
      },
      async deleteRecord(key) {
        parseCredentialKey(key)
        records.delete(key)
      },
    },
    connection: { fetch: { register(options) { handler = options.fetch; return () => {} } } },
    skills: { registerProvider() {} },
    tools: { register() { return () => {} } },
    effect(fn) { return fn() },
    emit() {},
    logger: { warn() {} },
  }
  apply(ctx, { baseUrl: 'http://127.0.0.1:3000' })
  records.set(tokenKey, {
    kind: 'grant',
    payload: { baseUrl: 'http://127.0.0.1:3000', token: 'test-token', expiresAt: Date.now() + 60_000 },
  })
  assert.equal(typeof handler, 'function')
  const response = await handler(new Request('http://localhost/api/dsh-chat-server/plugin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save-settings', showRightSidebar: false }),
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).value.showRightSidebar, false)
  assert.equal(records.get('dsh-chat-server/base-url').payload.showRightSidebar, false)
  assert.equal(records.get(tokenKey).payload.token, 'test-token')
})
