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

## Recover from invalid credential keys

Plugin versions through 0.2.2 could write credential record keys with the invalid scope `local.dsh-chat-server`. DSH may then fail to start its credentials service, even if the plugin is disabled. Updating the plugin alone cannot repair a credential file that DSH cannot load.

1. Stop every DSH process sharing the affected `DSH_HOME`. Back up the complete credentials YAML file to a private local location outside cloud sync and version control. Do not paste its contents into chat or logs. The default on Windows is `%USERPROFILE%\.dsh\.credentials.yaml`; `DSH_HOME` or the credentials provider configuration can override it.
2. In a trusted editor, find only the keys directly under `records:`. If the destination keys do not already exist, rename `local.dsh-chat-server/access-token` to `dsh-chat-server/access-token` and `local.dsh-chat-server/base-url` to `dsh-chat-server/base-url`. Leave each value and all other records unchanged. Either old key may be absent.
3. If an old key and its destination both exist, do not overwrite or merge them: determine which record to keep first. Alternatively, back up the file and remove only the two old Chat records, then configure the server address and pair again. Never clear the entire credentials file.
4. Do not reactivate the old plugin version, which can recreate invalid keys. Install the corrected plugin version after it is released, restart DSH, and verify other plugins and Chat. Keep the backup until verification succeeds.

### Windows 启动恢复

旧插件可能写入 `local.dsh-chat-server/access-token` 和 `local.dsh-chat-server/base-url` 两个不符合 DSH 格式的凭据键，导致凭据服务无法启动。请先退出所有使用同一 `DSH_HOME` 的 DSH 进程，备份默认位置 `%USERPROFILE%\.dsh\.credentials.yaml`（如自定义过路径则以实际配置为准），在可信编辑器中只将 `records:` 下这两个旧键分别改为 `dsh-chat-server/access-token` 和 `dsh-chat-server/base-url`，不要改变值或其他条目。若新旧键同时存在，不要覆盖或合并；也可备份后仅删除这两条旧记录，待安装修复版插件后重新配置地址和配对。不要将凭据文件或内容发给任何人，也不要重新启用旧插件。修复版发布前不要安装未经验证的版本豁免。

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
