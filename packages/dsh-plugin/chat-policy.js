import Schema from '@deepseek-ai/schemastery'

// Names supplied by the Chat preset itself. Names, not provider identities: a
// global tool with the same name may be visible if the preset tool is disabled.
export const CHAT_TOOLS = Object.freeze([
  'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'web_search', 'web_fetch', 'ask_user_question', 'present',
])

export const Config = Schema.object({
  allowedGlobalTools: Schema.array(Schema.string()).default([])
    .description('Additional exact tool names allowed in the Chat preset, including MCP tools.'),
  disabledTools: Schema.array(Schema.string()).default([])
    .description('Exact tool names denied in the Chat preset, including built-in tools.'),
})

export const inject = ['tools']

export function apply(ctx, config) {
  const disabled = new Set(config.disabledTools ?? [])
  const allowed = new Set([...CHAT_TOOLS, ...(config.allowedGlobalTools ?? [])].filter(name => !disabled.has(name)))
  let disposeMask
  let applied = null
  let updating = false
  let dirty = false
  let active = true

  // A guard covers the small synchronous gap between a registration and the
  // tools/change notification, and Agent-scoped tools that masks cannot hide.
  ctx.tools.guard(({ name }) => allowed.has(name) ? undefined : `Tool "${name}" is disabled in the Chat preset.`)

  function refresh() {
    if (!active) return
    dirty = true
    if (updating) return
    updating = true
    try {
      while (dirty && active) {
        dirty = false
        // definitions() with no scope is the global view. Restrictions at the
        // preset scope must name tools that exist now, not future MCP names.
        const denied = ctx.tools.definitions()
          .map(tool => tool.name)
          .filter(name => name !== 'run_code' && !allowed.has(name))
          .sort()
        const fingerprint = JSON.stringify(denied)
        if (fingerprint === applied) continue
        // Install first: intersecting masks avoid an opening during replacement.
        const next = ctx.tools.restrict({ deny: denied })
        const previous = disposeMask
        disposeMask = next
        applied = fingerprint
        previous?.()
      }
    } finally {
      updating = false
    }
  }

  ctx.on('tools/change', refresh)
  ctx.effect(() => {
    refresh()
    return () => {
      active = false
      disposeMask?.()
    }
  }, 'chat-preset: global tool mask')
}
