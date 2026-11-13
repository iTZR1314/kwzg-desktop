/** Client-side observable store and action facade wrapping `ctx.remote.parkwise`. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ParkwiseAttemptId, ParkwiseStatusView } from '@deepseek-ai/dsh-parkwise-connector/types'
import { ParkwiseBrowserLogin } from './browser-login.ts'

/** Complete UI snapshot rendered by ParkWise settings & plugin cards. */
export interface ParkwiseSnapshot {
  /** Latest status view streamed from Host; undefined before first snapshot arrives. */
  readonly view: ParkwiseStatusView | undefined
  /** Whether the `remote.parkwise.watch` stream failed or became unavailable. */
  readonly streamFailed: boolean
  /** Whether an action failed on the Host call itself. */
  readonly actionFailed: boolean
  /** Whether an asynchronous RPC (start / cancel / reconnect / signOut) is currently running. */
  readonly busy: boolean
}

/** Operations and observables injected into {@link ParkwisePanel}. */
export interface ParkwiseInjected {
  readonly hooks: {
    readonly parkwise: HostObservable<ParkwiseSnapshot>
  }
  readonly startSignIn: () => Promise<void>
  readonly cancelSignIn: (id: ParkwiseAttemptId) => Promise<void>
  readonly reconnect: () => Promise<void>
  readonly signOut: () => Promise<void>
}

/**
 * Resolve the browser-accessible callback origin used as OAuth `redirect_uri` origin.
 * Desktop uses the local Host HTTP stream server origin; Web uses `window.location.origin`.
 * @returns loopback HTTP(S) origin URL for OAuth callback registration.
 */
export function resolveCallbackOrigin(): string {
  const desktop = 'dshDesktop' in globalThis
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: { readonly streamBaseUrl?: string }
  }).__DSH_TRANSPORT__
  if (desktop && transport?.streamBaseUrl !== undefined) {
    return new URL(transport.streamBaseUrl).origin
  }
  return window.location.origin
}

/**
 * Create a self-contained observable store + action handler bound to `ctx`.
 * Callers must call `dispose()` on teardown; no module-level state is retained.
 * @param ctx - Client Cordis context carrying `remote.parkwise`.
 * @returns store snapshot reader, subscription, stream attachment, and actions.
 */
export function createParkwiseStore(ctx: ClientContext): {
  readonly face: ParkwiseInjected
  readonly attachStream: (stream: AsyncIterable<{ readonly value: { readonly state: ParkwiseStatusView } }>) => void
  readonly reset: () => void
  readonly markStreamFailed: () => void
  readonly dispose: () => void
} {
  let snapshot: ParkwiseSnapshot = {
    view: undefined,
    streamFailed: false,
    actionFailed: false,
    busy: false,
  }
  const desktop = 'dshDesktop' in globalThis
  const browser = new ParkwiseBrowserLogin(desktop)
  const listeners = new Set<() => void>()
  let stopped = false

  const publish = (next: Partial<ParkwiseSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }

  const runAction = async (work: () => Promise<void>): Promise<void> => {
    publish({ busy: true, actionFailed: false })
    try {
      await work()
    } catch {
      publish({ actionFailed: true })
    } finally {
      publish({ busy: false })
    }
  }

  const face: ParkwiseInjected = {
    hooks: {
      parkwise: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    startSignIn: () => runAction(async () => {
      await browser.start(async () => {
        const result = await ctx.remote.parkwise.startSignIn(resolveCallbackOrigin())
        if (!result.ok) throw new Error('parkwise startSignIn failed')
        publish({ view: result.value, streamFailed: false })
        return result.value
      }, () => snapshot.view)
    }),
    cancelSignIn: id => runAction(async () => {
      const result = await ctx.remote.parkwise.cancelSignIn(id)
      if (!result.ok) throw new Error('parkwise cancelSignIn failed')
      publish({ view: result.value })
    }),
    reconnect: () => runAction(async () => {
      const result = await ctx.remote.parkwise.reconnect()
      if (!result.ok) throw new Error('parkwise reconnect failed')
      publish({ view: result.value })
    }),
    signOut: () => runAction(async () => {
      const result = await ctx.remote.parkwise.signOut()
      if (!result.ok) throw new Error('parkwise signOut failed')
      publish({ view: result.value })
    }),
  }

  return {
    face,
    attachStream(stream) {
      const currentStream = stream as AsyncIterable<{
        readonly value: { readonly state: ParkwiseStatusView }
        readonly accept: () => void
      }>
      void (async () => {
        for await (const frame of currentStream) {
          if (stopped) return
          const view = frame.value.state
          publish({ view, streamFailed: false })
          browser.update(view)
          frame.accept()
        }
      })().catch(() => {
        if (!stopped) publish({ streamFailed: true })
      })
    },
    reset() {
      browser.dispose()
      publish({ view: undefined, streamFailed: false, actionFailed: false, busy: false })
    },
    markStreamFailed() {
      publish({ streamFailed: true })
    },
    dispose() {
      stopped = true
      browser.dispose()
      listeners.clear()
    },
  }
}
