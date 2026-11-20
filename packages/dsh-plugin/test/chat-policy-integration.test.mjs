import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import * as policy from '../chat-policy.js'

// This integration test uses the running DSH installation, not the user's profile.
// Set DSH_INSTALL_DIR to the directory containing @deepseek-ai/dsh/package.json.
const installDir = process.env.DSH_INSTALL_DIR
const enabled = Boolean(installDir)

async function setup(config = {}) {
  const require = createRequire(`${installDir}/package.json`)
  const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
  const { SystemPrompt } = await import(require.resolve('@deepseek-ai/dsh-system-prompt'))
  const { ToolsService } = await import(require.resolve('@deepseek-ai/dsh-tools'))
  const { createScope, bindScopeParent } = await import(require.resolve('@deepseek-ai/dsh-scope'))
  const native = await import(require.resolve('@deepseek-ai/dsh-tool-executor-native'))
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolsService, {})
  await root.plugin(native, {})
  const presetKey = {}
  const preset = createScope(root, presetKey)
  await preset.ctx.plugin(policy, config)
  const agent = {}
  const binding = bindScopeParent(agent, presetKey)
  return { root, preset, agent, binding, createScope }
}

function tool(name) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => name,
  }
}

async function addPresetTool(preset, name) {
  await preset.ctx.plugin(Object.assign(ctx => {
    ctx.tools.register(tool(name))
  }, { inject: ['tools'] }))
}

function names(root, agent) {
  return root.tools.schemas(agent).map(item => item.name)
}

async function call(root, agent, name) {
  const batch = await root.tools.execute({
    calls: [{ id: `call-${name}`, name, arguments: '{}' }],
    agent,
    signal: AbortSignal.timeout(3000),
  })
  return batch.results[0].result
}

test('Chat policy isolates dynamically registered global tools and follows preset scope', { skip: !enabled }, async () => {
  const { root, preset, agent, binding } = await setup({ allowedGlobalTools: ['mcp_allowed'] })
  try {
    await addPresetTool(preset, 'read')
    const other = {}
    let removeBlocked = root.tools.register(tool('mcp_blocked'))
    root.tools.register(tool('mcp_allowed'))
    assert.deepEqual(names(root, agent).sort(), ['mcp_allowed', 'read'])
    assert.deepEqual(names(root, other).sort(), ['mcp_allowed', 'mcp_blocked'])
    assert.equal((await call(root, agent, 'mcp_blocked')).isError, true)
    assert.equal((await call(root, agent, 'mcp_allowed')).isError, false)
    removeBlocked()
    assert.equal(names(root, agent).includes('mcp_blocked'), false)
    removeBlocked = root.tools.register(tool('mcp_blocked'))
    assert.equal(names(root, agent).includes('mcp_blocked'), false)
    assert.equal((await call(root, agent, 'mcp_blocked')).isError, true)
    binding.rebind({})
    assert.deepEqual(names(root, agent).sort(), ['mcp_allowed', 'mcp_blocked'])
    assert.equal((await call(root, agent, 'mcp_blocked')).isError, false)
  } finally {
    await preset.dispose()
    await root.fiber.dispose()
  }
})

test('disabled preset-local tools remain visible but execution is guarded', { skip: !enabled }, async () => {
  const { root, preset, agent } = await setup({ disabledTools: ['read'], allowedGlobalTools: ['read'] })
  try {
    await addPresetTool(preset, 'read')
    // Registry masks apply to inherited globals, not preset-local registrations.
    assert.equal(names(root, agent).includes('read'), true)
    assert.equal((await call(root, agent, 'read')).isError, true)
  } finally {
    await preset.dispose()
    await root.fiber.dispose()
  }
})

test('agent-local unlisted tools remain visible but are blocked by the preset guard', { skip: !enabled }, async () => {
  const { root, preset, agent, createScope } = await setup()
  const agentScope = createScope(root, agent)
  try {
    await addPresetTool(agentScope, 'agent_secret')
    assert.equal(names(root, agent).includes('agent_secret'), true)
    const result = await call(root, agent, 'agent_secret')
    assert.equal(result.isError, true)
    assert.match(result.error.message, /disabled in the Chat preset/)
  } finally {
    await agentScope.dispose()
    await preset.dispose()
    await root.fiber.dispose()
  }
})
