import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const installDir = process.env.DSH_INSTALL_DIR

test('bundle declares the standalone Chat preset and ships its policy', { skip: !installDir }, async () => {
  const require = createRequire(`${installDir}/package.json`)
  const { parse } = require('yaml')
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const entries = patch.flatMap(row => row.insert ?? [])
  const rows = entries.filter(row => row.id === 'preset-chat')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '@nevermindzzt/dsh-chat-server/chat-preset')
  assert.equal(rows[0].config.id, 'chat')
  assert.equal(entries.some(row => row.id === 'preset-standard'), false)
  const plugins = rows[0].config.plugins
  const byId = Object.fromEntries(plugins.map(row => [row.id, row]))
  for (const id of ['chat-tool-policy', 'persona', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-ask-user', 'present', 'compaction']) assert.ok(byId[id], id)
  assert.equal(byId['tool-fs-search'].config.sampleOverCapGlobResults, false)
  assert.equal(byId.persona.config.complete, true)
  assert.equal(byId.persona.config.includeRuntimeContext, false)
  assert.deepEqual(byId['chat-tool-policy'].config, { allowedGlobalTools: [], disabledTools: [] })
  assert.equal(byId['chat-tool-policy'].name, '@nevermindzzt/dsh-chat-server/chat-policy')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./chat-policy'], './chat-policy.js')
  assert.ok(pkg.files.includes('chat-policy.js'))
  assert.equal(pkg.exports['./chat-preset'], './chat-preset.js')
  assert.equal(pkg.exports['./chat-preset/icon'], './icon.svg')
  assert.equal(pkg.exports['./chat-preset/locale/*.json'], './chat-preset-locale/*.json')
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(new URL(`../chat-preset-locale/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(locale.meta.title)
    assert.ok(locale.meta.description)
  }
})
