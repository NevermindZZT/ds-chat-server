# Project instructions

## Persistent verification service

- After every code or configuration change, keep the Chat Server test service running and listening on `0.0.0.0` so the user can verify it. Do not stop the API or web preview after testing unless the user asks.
- Local development defaults: the API and Rspack-built UI are served together by Fastify with `HOST=0.0.0.0`, port `3000`; Rspack runs as a build watcher, not a separate HTTP server. After edits, wait for watch/HMR rebuilds and verify the health endpoint and website on the same origin respond.
- Use Node.js 24 or newer for development, builds, and runtime checks.
- Docker Compose is a single Chat Server container with persistent SQLite storage; do not add a separate database container unless the user changes this requirement.
- Do not run `git commit` or `git push` without a direct user instruction.

## Commit approval

- Do not run `git commit` or `git push` after making changes. Leave the working tree uncommitted and wait for the user to review the changes.
- Commit or push only after the user explicitly instructs it in a later message.

## Sandbox tool arguments

- Omit `sandbox_permissions` and `justification` unless the operation genuinely needs elevated access beyond the current session policy.
- When elevation is genuinely required, `sandbox_permissions` may only be `workspace-write` or `danger-full-access`. `use_default` is not a valid value and must never be passed.
- Pass `justification` only together with a required `sandbox_permissions` value. Never pass it alone.
- Normal reads, writes, searches, builds, and service checks should omit both fields.
