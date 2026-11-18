# DSH Chat plugin

`@nevermindzzt/dsh-chat-server` opens the DeepSeek Chat website inside DSH and adds an **import current conversation** action. The chat UI is the website itself, so both share one design and one feature set.

## Install

From npm:

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server
```

Or install `packages/dsh-plugin` as a local bundle in DSH **Plugins → Add plugin**, then enable **Chat**.

## Use

1. **插件 → Chat** 设置服务端地址（例如 `http://127.0.0.1:3000`），保存。
2. 在同一页面生成一次性配对码（Chat Server 网站 **设置 → DSH 插件配对**）并点击 **连接**。地址保存在 DSH credentials；修改地址会清除配对。
3. 左侧导航打开 **Chat**，即嵌入的网站聊天页面；首次使用在该页面登录 Chat Server。
4. 打开一个会话后，面板顶部选择 DSH Workspace，点击 **导入当前会话**，把网站当前可见分支写入 DSH Session。

The panel reports the active session to the host from the embedded page, so import follows whichever conversation is open in the iframe.

## Settings

The bundle settings page in **插件 → Chat** follows DSH's settings rows and provides:

- Server address, saved through the Host plugin route.
- Connection status and credential expiry.
- One-time pairing code, connect and disconnect.

No token or code is written to the plugin config, browser storage, or the iframe URL.

## Host actions

The page and iframe talk to the Host through `POST /api/dsh-chat-server/plugin` on the authenticated DSH Connection Fetch carrier:

`get-settings`, `save-settings`, `status`, `pair`, `disconnect`, `sessions`, `session`, `create-session`, `save-session`, `delete-session`, `models`, `metrics`, `workspaces`, `import`, `stream`.

Chat Server endpoints: `POST /api/v1/dsh/pair`, `POST /api/v1/dsh/revoke`, `GET /api/v1/dsh/models`, Skills and MCP Gateways, session CRUD, metrics, `POST /api/anthropic/v1/messages`, and attachment reads during import. The Host never forwards a Client-supplied upstream URL or Authorization header.

## Verification limits

- Installed and enabled in the current DSH profile; the **Chat** entry, iframe panel, and settings rows were checked in the running Web UI.
- Pairing against a real Chat Server and a full import are left for the logged-in user to verify because the agent has no Chat Server credentials.
- The embedded page relies on same-site cookies between the DSH origin and the configured Chat Server address; use the same host (for example both `127.0.0.1`) so the login cookie is sent inside the frame.
