# DeepSeek Chat

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/NevermindZZT/ds-chat-server/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/nevermindzzt/ds-chat-server)](https://hub.docker.com/r/nevermindzzt/ds-chat-server)
[![npm](https://img.shields.io/npm/v/@nevermindzzt/dsh-chat-server)](https://www.npmjs.com/package/@nevermindzzt/dsh-chat-server)
[![Release](https://github.com/NevermindZZT/ds-chat-server/actions/workflows/release.yml/badge.svg)](https://github.com/NevermindZZT/ds-chat-server/actions/workflows/release.yml)

[English](README.md) | [简体中文](README.zh-CN.md)

A self-hosted DeepSeek Chat web service built on the official [DeepSeek Chat Demo](https://github.com/deepseek-ai/chat-demo), with a DSH plugin that opens the same chat inside DeepSeek Harness. The React UI keeps the Demo's conversation branches, streaming/thinking, DeepSeek search and link reading, file input, voice features, Markdown, themes, localization, and ZIP history workflow. A Node.js 24+ server proxies DeepSeek requests and stores sessions, settings, metrics, and attachments in a persistent SQLite database/file volume. The service also provides MCP and Skills extensions and includes an installable DSH plugin under `packages/dsh-plugin`.

## Docker Compose

1. Copy `.env.example` to `.env`.
2. The first-run administrator is `admin` / `admin123`; first login forces a password change. Change the default before exposing the site.
3. Pull and start the published single application container:

```sh
docker compose pull
docker compose up -d
```

The published image is `nevermindzzt/ds-chat-server` (tags: `latest` and release versions). To build from source instead, run `docker compose up -d --build`. The equivalent `docker run` is:

```sh
docker run -d --name ds-chat-server --env-file .env \
  -p 127.0.0.1:8080:3000 -v chat_data:/data \
  nevermindzzt/ds-chat-server:latest
```

Open <http://127.0.0.1:8080>.

For an image-only deployment that never builds locally, use [`compose.hub.yaml`](compose.hub.yaml):

```sh
docker compose -f compose.hub.yaml pull
docker compose -f compose.hub.yaml up -d
```

`CHAT_SERVER_IMAGE_TAG` selects the image tag (default `0.2.0`; use `latest` for the newest release). Set a DeepSeek API Key in **Settings → Data**, or provide `DEEPSEEK_API_KEY` in `.env`. User-entered keys are encrypted at rest. SQLite, uploaded originals, Skills, and the generated encryption secret live in the persistent `chat_data` volume under `/data`.

The Compose port binds to loopback by default. For public access, terminate TLS at a reverse proxy, set `COOKIE_SECURE=true` and `TRUST_PROXY=true` as appropriate, and review applicable content-safety and service-provider obligations. **Stop the container before copying the SQLite data volume** so the WAL is checkpointed. Back up the complete `chat_data` volume; it contains both `chat.sqlite` and attachment files.

## Features

- **Chat Demo parity:** multi-conversation history, automatic titles, edit/regenerate/continue, branches, streaming, deep thinking, web search, URL reading, citations, files, content safety, ASR/TTS, Markdown/KaTeX/Mermaid, Chinese/English, light/dark, and responsive layouts.
- **Server persistence:** account, encrypted API credentials, conversation branches, uploaded file originals, history ZIP import/export, and session metrics.
- **Account:** change the administrator username and password in **Settings → Account**; the first-run password must be changed after the initial login. Passwords require at least 8 characters. Sessions last 30 days and renew automatically while the account stays active.
- **MCP:** configure Streamable HTTP or allowlisted stdio servers in **Settings → MCP**; test discovery and enable tools individually by server. Connections are disabled until explicitly enabled. Stdio requires `MCP_STDIO_ALLOWLIST` and an executable present in the app container.
- **Skills:** import a folder containing one or more `SKILL.md` files in **Settings → Skills**. In a conversation, use `/skill list`, `/skill <name>` to enable, or `/skill -<name>` to disable a Skill. Only enabled Skills are loaded into that conversation's model context.
- **Context compaction:** configure the automatic trigger percentage, target percentage, and number of recent turns in **Settings → General**. Use `/compact [instructions]` in a conversation for manual compaction. Original messages remain visible; the model receives the saved summary plus unsummarized turns. Editing or switching branches invalidates the summary.
- **Performance:** each session shows turn count, average first-token time, average output TPS, token totals, cache hit rate, and latest context-window usage. The model context window defaults to 128,000 tokens and can be adjusted with `DEEPSEEK_CONTEXT_WINDOW` (or a model-specific `CONTEXT_WINDOW_<MODEL>` variable).
- **Cross-site embedding:** when DSH and the Chat Server are on different sites and the browser blocks third-party cookies, the DSH plugin requests a short-lived browser token so the embedded chat still authenticates.
- **DSH:** the `@nevermindzzt/dsh-chat-server` plugin adds a **Chat** entry to DSH's left navigation that opens the Chat Server website inside DSH, plus an **import current conversation** action. Configure the address and one-time pairing code in the plugin settings. It also registers the Chat Server model provider, Skills provider, and MCP tool bridge.

## Development

Use Node.js **24 or later** and pnpm:

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the frontend in watch mode and serves it with the API from the same Fastify listener on port `3000`; `/api/...` routes and the website share one origin. Local development stores SQLite and uploads under `.data/`. Useful checks:

```sh
pnpm type
pnpm lint
pnpm build
```

### DSH plugin

Install the published plugin from npm:

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server
```

If pnpm uses a China mirror that has not synced this package yet, add the official registry or install the tarball:

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server --registry=https://registry.npmjs.org
dsh plugin --profile web add https://registry.npmjs.org/@nevermindzzt/dsh-chat-server/-/dsh-chat-server-0.2.0.tgz
```

Remove an older `@local/dsh-chat-server` bundle to avoid duplicate **Chat** entries:

```sh
dsh plugin --profile web remove @local/dsh-chat-server
```

Or install it through DSH **Plugins → Add plugin** using the package name `@nevermindzzt/dsh-chat-server`, then enable **Chat**. Open **插件 → Chat** to set the Chat Server address and one-time pairing code; changes are stored by DSH's credential service, not in ordinary plugin configuration. The same bundle can be installed from the local directory `packages/dsh-plugin`. See the [plugin README](packages/dsh-plugin/README.md) for details.

### Data and security

- SQLite stores accounts, session branches, settings, and generation metrics. Uploaded originals are stored under `DATA_DIR`; DeepSeek `file_id` values are maintained separately from local attachment IDs.
- The browser uses an HttpOnly same-origin session cookie. API keys are never returned to the browser after being saved.
- `APP_SECRET` protects encrypted credentials and session cookies. If omitted, a random secret is created in `DATA_DIR`; keep that volume private and backed up.
- Never expose stdio MCP command execution to untrusted users. Add only reviewed executables to `MCP_STDIO_ALLOWLIST`.
- History ZIP imports are validated before replacing the server-side history. Keep a stopped-volume backup before upgrades.

## Release

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml):

- builds a multi-arch `linux/amd64,linux/arm64` image and pushes `nevermindzzt/ds-chat-server:<version>` plus `latest`;
- sets the plugin version from the tag and publishes `@nevermindzzt/dsh-chat-server` to npm.

Configure these repository secrets first: `DOCKERHUB_USERNAME` (`NevermindZZT`), `DOCKERHUB_TOKEN` (Docker Hub access token), and `NPM_TOKEN` (npm automation token for the `@nevermindzzt` scope). The Docker Hub repository and npm scope must exist for the first release.

```sh
git tag v0.2.0
git push origin v0.2.0
```

## License

The upstream Chat Demo and this project are MIT-licensed; retain [LICENSE](LICENSE). Third-party dependencies remain subject to their respective licenses.
