# DeepSeek Chat

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/NevermindZZT/ds-chat-server/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/nevermindzzt/ds-chat-server)](https://hub.docker.com/r/nevermindzzt/ds-chat-server)
[![npm](https://img.shields.io/npm/v/@nevermindzzt/dsh-chat-server)](https://www.npmjs.com/package/@nevermindzzt/dsh-chat-server)
[![Release](https://github.com/NevermindZZT/ds-chat-server/actions/workflows/release.yml/badge.svg)](https://github.com/NevermindZZT/ds-chat-server/actions/workflows/release.yml)

[English](README.md) | 简体中文

本项目基于 DeepSeek 官方 [Chat Demo](https://github.com/deepseek-ai/chat-demo)，提供**单容器自托管网站服务**，并附带在 DSH 内直接打开同一聊天页面的插件。保留 React UI 的会话分支、流式回答/思考、搜索与链接阅读、文件、语音、Markdown、主题、多语言和 ZIP 历史能力；Node.js 24+ 服务端代理 DeepSeek API，并将账户、会话、设置、指标和附件保存在持久化 SQLite 数据文件中。服务支持 MCP、Skills，并提供位于 `packages/dsh-plugin` 的 DSH 插件。

## Docker Compose 部署

1. 将 `.env.example` 复制为 `.env`。
2. 首次启动管理员账号为 `admin` / `admin123`，首次登录会强制修改密码；对外开放前必须更换。
3. 拉取并启动唯一的应用容器：

```sh
docker compose pull
docker compose up -d
```

发布镜像为 `nevermindzzt/ds-chat-server`（标签：`latest` 与版本号）。如需从源码构建，使用 `docker compose up -d --build`。等价的 `docker run`：

```sh
docker run -d --name ds-chat-server --env-file .env \
  -p 127.0.0.1:8080:3000 -v chat_data:/data \
  nevermindzzt/ds-chat-server:latest
```

打开 <http://127.0.0.1:8080>。在 **设置 → 数据管理** 配置 DeepSeek API Key，也可以在 `.env` 设置 `DEEPSEEK_API_KEY`。用户输入的 API Key 会加密后保存在服务端。SQLite 数据库、上传原件、Skills 和自动生成的加密密钥都保存在持久化 `chat_data` 卷（容器内 `/data`）。

Compose 默认只绑定本机回环地址。若要公网访问，应通过反向代理提供 HTTPS，并按部署方式设置 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。公开提供服务时还需评估适用的内容安全和服务提供者义务。备份时请先停止容器，确保 SQLite WAL 检查点完成，再备份**整个 `chat_data` 卷**，其中既有 `chat.sqlite` 也有附件文件。

## 功能

- **Chat Demo 功能**：多会话、自动标题、编辑/重新生成/继续、消息分支、流式回答、深度思考、网页搜索、URL 阅读、引用、文件、内容安全、语音转写/朗读、Markdown/KaTeX/Mermaid、中英文、浅色/深色和响应式布局。
- **服务端持久化**：账户、加密 API 凭证、会话及分支、上传文件原件、历史 ZIP 导入导出和性能指标。
- **MCP**：在 **设置 → MCP** 配置 Streamable HTTP 或加入命令白名单的 stdio Server，测试工具发现并按需启用；新连接默认停用。stdio 命令必须在 `MCP_STDIO_ALLOWLIST` 中明确允许且程序已安装在容器内。
- **Skills**：在 **设置 → Skills** 导入含一个或多个 `SKILL.md` 的文件夹。会话中使用 `/skill list` 查看、`/skill <名称>` 启用、`/skill -<名称>` 停用；只有启用的 Skill 会载入该会话模型上下文。
- **上下文压缩**：在 **设置 → 通用设置** 配置自动触发比例、目标比例和保留的最近轮次；会话中使用 `/compact [指令]` 手动压缩。原始历史仍可查看，模型请求改用摘要和未压缩的新轮次。编辑或切换消息分支会使旧摘要失效。
- **会话指标**：显示轮次、平均首字时间、平均输出 TPS、Token 总量、缓存命中率和最近一次上下文使用比例。模型窗口默认按 128,000 Token 估算，可通过 `DEEPSEEK_CONTEXT_WINDOW` 或 `CONTEXT_WINDOW_<MODEL>` 调整。
- **DSH 插件**：`@nevermindzzt/dsh-chat-server` 在 DSH 左侧导航新增 **Chat** 入口，在 DSH 内打开 Chat Server 网站聊天页面，并提供“导入当前会话”操作。在插件设置页配置服务端地址和一次性配对码；同时注册 Chat Server 模型、Skills Provider 和 MCP 工具桥接。

## 开发

需要 Node.js **24 或更新版本**和 pnpm：

```sh
pnpm install
pnpm dev
```

`pnpm dev` 以 watch 模式构建前端，并由同一个 Fastify 监听端口提供页面和 API，默认端口 `3000`；网站与 `/api/...` 共用同源 URL。开发数据与附件保存在 `.data/`。检查命令：

```sh
pnpm type
pnpm lint
pnpm build
```

### 安装 DSH 插件

从 npm 安装插件：

```sh
dsh plugin --profile web add @nevermindzzt/dsh-chat-server
```

也可以在 DSH 的 **Plugins → Add plugin** 中输入包名 `@nevermindzzt/dsh-chat-server` 安装，然后启用 **Chat**。在 **插件 → Chat** 中配置 Chat Server 地址和一次性配对码；凭证通过 DSH Credential 服务保存，不写入普通插件配置。也可以直接安装本地目录 `packages/dsh-plugin`。详见[插件 README](packages/dsh-plugin/README.md)。

### 数据与安全

- SQLite 保存账户、会话分支、设置和生成指标。附件原件保存在 `DATA_DIR`；本站附件 ID 与 DeepSeek `file_id` 分开保存。
- 浏览器使用同源 HttpOnly Session Cookie；API Key 保存后不会再次返回浏览器。
- `APP_SECRET` 用于加密凭证及签名会话 Cookie。未设置时随机密钥写入 `DATA_DIR`；请保护并备份数据卷。
- 不要让不可信用户随意执行 stdio MCP 命令；仅将审核过的程序加入 `MCP_STDIO_ALLOWLIST`。
- 导入历史 ZIP 会先校验再替换服务端历史。升级前先停止服务并备份数据卷。

## 许可证

上游 Chat Demo 与本项目使用 MIT 许可证；请保留 [LICENSE](LICENSE)。第三方依赖遵循各自许可证。
