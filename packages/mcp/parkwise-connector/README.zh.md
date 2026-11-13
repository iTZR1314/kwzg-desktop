---
description: "内置瞰维智管（ParkWise）MCP 连接器：提供浏览器 OAuth 2.0 + PKCE 网页登录授权、内置操作 Skill 与默认系统提示词引导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-parkwise-connector

[English](README.md) | 中文

## 概述

将内置的 `parkwise` Streamable HTTP MCP 服务（`https://kwzg.yizuw.cn/gw/mcp`）注册到 `ctx.mcpManager`，通过浏览器打开网页完成 OAuth 2.0 + PKCE（`S256`）授权登录，并内置 `parkwise-skill` 与默认的 MCP 分层调用提示词引导。

## 目录

- [使用方式](#use-this-package)
- [实现细节](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续计划](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

在服务端应用包（`packages/bundle/web-app`）中与 `credentials`、`mcpManager` 一同挂载。服务启动后会注册 `parkwise` MCP 服务并使用 `${credential:PARKWISE_MCP_TOKEN}`；未登录时静默等待凭据，网页 OAuth 授权完成后自动连接并向模型暴露 `mcp__parkwise__*` 工具。

<a id="understand-the-implementation"></a>
## 实现细节

<details>
<summary>内部实现说明</summary>

`ParkwiseConnector` 继承 `TypertRemoteService`，以 `parkwise` 命名空间向前端暴露 `getState`、`watch`、`startSignIn`、`cancelSignIn`、`reconnect` 与 `signOut`。`src/oauth.ts` 负责 OAuth 元数据发现、PKCE 交换/刷新与授权回跳页渲染；`src/skill.ts` 挂载内置 `parkwise-skill` 与默认 `systemPrompt` 指引。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [mcp-manager](../mcp-manager/README.zh.md) — 管理注册的 `parkwise` MCP 实例与工具生命周期。
- [ui-settings-parkwise](../../client/ui-settings-parkwise/README.zh.md) — 设置页与插件页的网页登录授权界面。

<a id="model-experience"></a>
## 模型体验

### ParkWise 指引、内置技能与工具暴露

#### 模型可见内容

授权完成后，模型可看到 `mcp__parkwise__*` 工具、`ctx.skills` 中的 `parkwise-skill` 摘要以及位于 `MCP_SERVERS` 之后的 `parkwise:mcp-guidance` 系统提示词；未授权时引导用户前往设置或插件页完成网页 OAuth 登录。

#### Token 影响

默认指引段落约为 140 tokens；完整 `parkwise-skill` 仅在模型按需调用 `skill` 加载时进入上下文。

#### KV Cache 影响

提示词在已授权与未授权两种状态内保持稳定，仅在登录/退出切换时发生变化。

## 已知限制与后续计划

<a id="known-limitations-and-deferred-work"></a>

- **网关回环回调白名单要求** — 连接线上网关 `https://kwzg.yizuw.cn` 时，需要网关服务端支持 `127.0.0.1` / `localhost` / `[::1]` 回环回调、`S256` PKCE 校验及 `DeepSeek Harness` 客户端名称。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
