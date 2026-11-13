---
description: "Settings and Plugins page for ParkWise Smart Park MCP browser OAuth authorization and live connection status."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-parkwise

English | [中文](README.zh.md)

## Summary

Registers the **ParkWise (瞰维智管)** configuration view in both **Settings** and **Plugins -> Official**. Users can open the ParkWise gateway login page in a browser tab (Web) or the OS default browser (Desktop), view the current enterprise tenant slug and live MCP connection status, reconnect, or sign out.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-client-ui-settings-parkwise` beside `@deepseek-ai/dsh-parkwise-connector` in the web-app bundle. While `remoteAccess` grants `parkwise/watch`, the UI subscribes to `remote.parkwise.watch` and provides one-click browser OAuth sign-in.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half (`src/index.ts`) exports an empty `apply` so Loader discovers `dsh.client`. The Client half (`src/client/index.ts`) opens a pre-opened blank tab on Web or uses Desktop's `setWindowOpenHandler` via `ParkwiseBrowserLogin` (`src/client/browser-login.ts`) and bridges `remote.parkwise` to a React `HostObservable` store (`src/client/parkwise-store.ts`).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [parkwise-connector](../../mcp/parkwise-connector/README.md) — Host service managing the OAuth PKCE flow and MCP registration.
- [ui-settings](../ui-settings/README.md) — Settings section slot contract.
- [ui-plugin-manager](../ui-plugin-manager/README.md) — Official plugin item slot contract.

<a id="model-experience"></a>
## Model Experience

None, as this package is a browser-side settings UI and registers no model tools or prompt sections.

#### KV Cache effect

None; this package neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Depends on Host connector availability** — controls render only while `remoteAccess` grants `parkwise/watch` from `@deepseek-ai/dsh-parkwise-connector`.
