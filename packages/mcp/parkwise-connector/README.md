---
description: "Built-in ParkWise Smart Park MCP connector with browser OAuth 2.0 + PKCE login, bundled operation skill, and default MCP guidance."
kind: "package-reference"
---

# @deepseek-ai/dsh-parkwise-connector

English | [中文](README.zh.md)

## Summary

Registers the built-in `parkwise` Streamable HTTP MCP server (`https://kwzg.yizuw.cn/gw/mcp`) on `ctx.mcpManager`, drives browser OAuth 2.0 + PKCE (`S256`) login against the ParkWise gateway, bundles `parkwise-skill` for progressive three-tier MCP invocation, and contributes default SystemPrompt usage guidance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `ParkwiseConnector` alongside `credentials` and `mcpManager` in the host bundle (`packages/bundle/web-app`). The service registers the `parkwise` MCP server immediately and uses `${credential:PARKWISE_MCP_TOKEN}` so `mcp-client` waits silently while signed out and connects automatically as soon as OAuth finishes.

On `startSignIn(callbackOrigin)`, the service registers `/oauth/parkwise/callback` on the optional `webServer`, discovers `/.well-known/oauth-authorization-server` on `oauthOrigin` (falling back to `/gw/oauth/authorize` and `/gw/oauth/token`), returns an authorize URL with `S256` PKCE challenge, exchanges the code upon browser callback, stores the grant at `parkwise-mcp/default`, and writes `PARKWISE_MCP_TOKEN` into `ctx.credentials`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ParkwiseConnector` extends `TypertRemoteService` under the `parkwise` Remote namespace and exports client-safe status types from `./types`. `src/oauth.ts` handles metadata discovery, origin checks, token exchange/refresh, and the self-closing callback page. `src/skill.ts` reads `assets/skills/parkwise-skill/SKILL.md` for optional `ctx.skills` and registers `parkwise:mcp-guidance` on optional `ctx.systemPrompt` right after `MCP_SERVERS`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mcp-manager](../mcp-manager/README.md) — manages the registered `parkwise` `dsh-mcp-client` instance and emits status updates.
- [ui-settings-parkwise](../../client/ui-settings-parkwise/README.md) — browser and Desktop authorization UI consuming `remote.parkwise`.

-----

<a id="model-experience"></a>
## Model Experience

### ParkWise guidance, skill summary, and connected tools

#### What the model sees

When authorized, the model receives `mcp__parkwise__*` tools from `mcp-client`, the bundled `parkwise-skill` summary in `ctx.skills`, and the `parkwise:mcp-guidance` section in the system prompt right after `MCP_SERVERS` reminding it to load `parkwise-skill` and follow `proc_*` -> Views -> Reducers. When signed out, no MCP tools are attached and `parkwise:mcp-guidance` tells the model to guide the user to Settings / Plugins -> ParkWise to sign in.

#### Token effect

The short guidance section adds ~140 tokens to assembled prompts while enabled; the full `parkwise-skill` instructions (~2.5k tokens) enter session history only when loaded on demand through `skill`.

#### KV Cache effect

Guidance text stays invariant within a connected or disconnected state and only flips when ParkWise OAuth authorization state transitions between signed-out and stored credentials.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Gateway loopback OAuth requirement** — connecting to the hosted ParkWise gateway (`https://kwzg.yizuw.cn`) requires the gateway's OAuth allowlist to accept RFC 8252 loopback redirect URIs (`127.0.0.1`, `localhost`, `[::1]`) with `S256` PKCE and client name `DeepSeek Harness`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
