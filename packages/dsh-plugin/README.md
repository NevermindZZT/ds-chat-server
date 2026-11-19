# DSH Chat plugin

`@nevermindzzt/dsh-chat-server` opens your self-hosted DeepSeek Chat inside DSH. Use **Chat** in the left navigation for the full page, or enable its entry in the right-sidebar guide from the plugin settings. The full panel can import the current conversation into a DSH Workspace; the plugin also bridges Chat Server models, Skills and MCP tools.

在 DSH 左侧的 **Chat** 中打开聊天页面，也可以在插件设置中启用右侧边栏入口。先配置服务端地址，再从网站 **设置 → DSH 插件配对** 生成一次性配对码并连接。聊天面板支持将当前会话导入指定的 DSH Workspace，同时提供模型、Skills 和 MCP 工具桥接。

## Install

From npm:

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server
```

If your pnpm uses a China mirror such as `registry.npmmirror.com` and reports `No matching version found`, install from the official registry or the npm tarball:

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server --registry=https://registry.npmjs.org

# or install the tarball directly
dsh plugin --profile web add https://registry.npmjs.org/@nevermindzzt/dsh-chat-server/-/dsh-chat-server-0.2.2.tgz
```

Or install `packages/dsh-plugin` as a local bundle in DSH **Plugins → Add plugin**, then enable **Chat**.

If an older `@local/dsh-chat-server` bundle is still installed, disable it in **Plugins** and remove it, otherwise both **Chat** entries appear:

```sh
dsh plugin --profile web remove @local/dsh-chat-server
```

## Use

1. **插件 → Chat** 设置服务端地址（例如 `http://127.0.0.1:3000`），保存。
2. 在同一页面生成一次性配对码（Chat Server 网站 **设置 → DSH 插件配对**）并点击 **连接**。地址保存在 DSH credentials；修改地址会清除配对。
3. 左侧导航打开 **Chat**，即嵌入的网站聊天页面；首次使用在该页面登录 Chat Server。
4. 打开一个会话后，面板顶部选择 DSH Workspace，点击 **导入当前会话**，把网站当前可见分支写入 DSH Session。

The panel reports the active session to the host from the embedded page, so import follows whichever conversation is open in the iframe.

## Settings

The bundle settings page in **插件 → Chat** follows DSH's settings rows and provides:

- Server address, saved through the Host plugin route.
- A switch for the Chat entry in the right-sidebar guide.
- Connection status and credential expiry.
- One-time pairing code, connect and disconnect.

The pairing token is held by DSH's credential service. For embedded sessions, a short-lived browser token is passed in the iframe URL fragment and stored in sessionStorage; protect access to the DSH instance and use HTTPS for remote deployments.

## Host actions

The page and iframe talk to the Host through `POST /api/dsh-chat-server/plugin` on the authenticated DSH Connection Fetch carrier:

`get-settings`, `save-settings`, `status`, `browser-token`, `pair`, `disconnect`, `sessions`, `session`, `create-session`, `save-session`, `delete-session`, `models`, `metrics`, `workspaces`, `import`, `stream`.

When third-party cookies are blocked, `browser-token` obtains a 12-hour Chat Server bearer token and passes it to the iframe in the URL fragment; the website stores it in sessionStorage and uses it for same-origin API requests. The fragment is removed from the address bar immediately and is never sent to the server in the request URL.

Chat Server endpoints: `POST /api/v1/dsh/pair`, `POST /api/v1/dsh/revoke`, `GET /api/v1/dsh/models`, Skills and MCP Gateways, session CRUD, metrics, `POST /api/anthropic/v1/messages`, and attachment reads during import. The Host never forwards a Client-supplied upstream URL or Authorization header.

## Verification limits

- Installed and enabled in the current DSH profile; the **Chat** entry, iframe panel, and settings rows were checked in the running Web UI.
- Pairing against a real Chat Server and a full import are left for the logged-in user to verify because the agent has no Chat Server credentials.
- The embedded page uses a short-lived browser token for authenticated API requests when paired. Browser and network policies can still block iframe embedding; use the **Open in new tab** action if needed.
