---
description: "瞰维智管（ParkWise）智慧园区 MCP 的设置与插件界面：支持打开网页 OAuth 登录授权与连接状态管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-parkwise

[English](README.md) | 中文

## 概述

在侧边栏「设置」和「插件 -> 官方」中注册**瞰维智管 (ParkWise)** 管理页。用户可通过「打开网页登录授权」在浏览器完成 OAuth 2.0 + PKCE 授权，查看当前企业标识、可用 MCP 工具数量、重连或退出授权。

## 目录

- [使用方式](#use-this-package)
- [实现细节](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续计划](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用方式

在 `@deepseek-ai/dsh-web-app` 中随 `@deepseek-ai/dsh-parkwise-connector` 一同加载。当 `remoteAccess` 允许 `parkwise/watch` 时自动展示。

<a id="understand-the-implementation"></a>
## 实现细节

<details>
<summary>内部实现说明</summary>

Host 侧为空 `apply`，Client 侧通过 `ParkwiseBrowserLogin` 在 Web 端预开标签页或在 Desktop 端拉起系统默认浏览器访问网关授权页，并通过 `remote.parkwise.watch` 实时更新状态。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [parkwise-connector](../../mcp/parkwise-connector/README.zh.md) — 负责 OAuth PKCE 流程与 MCP 注册的 Host 服务。
- [ui-settings](../ui-settings/README.zh.md) — 设置页面分区插槽契约。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md) — 官方插件列表插槽契约。

<a id="model-experience"></a>
## 模型体验

无，本包仅为浏览器端界面，不向模型注册工具或提示词。

#### KV Cache 影响

无。

## 已知限制与后续计划

<a id="known-limitations-and-deferred-work"></a>

- **依赖 Host 侧连接器加载** — 仅当 `remoteAccess` 授予 `parkwise/watch` 时显示页面与操作按钮。
