// @vitest-environment jsdom
/**
 * Browser UI & Remote slot tests for `@deepseek-ai/dsh-client-ui-settings-parkwise`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ParkwiseStatusView, ParkwiseUpdate } from '@deepseek-ai/dsh-parkwise-connector/types'
import { apply as hostApply } from '../src/index.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { ParkwisePluginCard, ParkwiseSettingsSection, type ParkwiseSettingsSectionProps } from '../src/client/ParkwiseCard.tsx'
import type {
  ParkwiseBrandCompanyProps,
  ParkwiseLauncherSublabelProps,
} from '../src/client/ParkwiseBrand.tsx'
import type { ParkwiseInjected } from '../src/client/parkwise-store.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const tZh = ((key: keyof typeof zh, params?: Record<string, string | number>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => (
    params !== undefined && name in params ? String(params[name]) : match
  ))) as Parameters<typeof ParkwiseSettingsSection>[0]['t']

function injectedOf(entry: { inject?: (() => object) | undefined }): ParkwiseInjected {
  const injected: object = entry.inject!()
  return injected as ParkwiseInjected
}

function makeSignedOutView(): ParkwiseStatusView {
  return {
    authStatus: 'signed-out',
    serverName: 'parkwise',
    mcpUrl: 'https://kwzg.yizuw.cn/gw/mcp',
    oauthOrigin: 'https://kwzg.yizuw.cn',
    mcpState: 'waiting-credentials',
    attempt: null,
  }
}

function makeBench() {
  const ctx = new Context()
  const streamControllers: Array<{
    push: (update: ParkwiseUpdate) => void
    close: () => void
  }> = []

  const startSignIn = vi.fn(async (_origin: string) => ({
    ok: true as const,
    value: {
      ...makeSignedOutView(),
      attempt: { id: 'attempt-1' as never, phase: 'initializing' as const },
    },
  }))
  const cancelSignIn = vi.fn(async () => ({
    ok: true as const,
    value: makeSignedOutView(),
  }))
  const reconnect = vi.fn(async () => ({
    ok: true as const,
    value: {
      ...makeSignedOutView(),
      authStatus: 'credential-stored' as const,
      tenantSlug: 'demo-park',
      mcpState: 'connected' as const,
      toolCount: 12,
    },
  }))
  const signOut = vi.fn(async () => ({
    ok: true as const,
    value: makeSignedOutView(),
  }))

  const remote = new TestRemote(ctx, {
    parkwise: {
      startSignIn,
      cancelSignIn,
      reconnect,
      signOut,
      watch: (signal: AbortSignal) => ({
        async *[Symbol.asyncIterator]() {
          const queue: ParkwiseUpdate[] = []
          let wake: (() => void) | undefined
          let done = false
          const onAbort = () => {
            done = true
            wake?.()
          }
          signal.addEventListener('abort', onAbort, { once: true })
          streamControllers.push({
            push: (update) => {
              queue.push(update)
              wake?.()
              wake = undefined
            },
            close: () => {
              done = true
              wake?.()
              wake = undefined
            },
          })
          try {
            while (!done) {
              if (queue.length > 0) {
                yield queue.shift()!
                continue
              }
              await new Promise<void>((resolve) => { wake = resolve })
            }
          } finally {
            signal.removeEventListener('abort', onAbort)
          }
        },
      }),
    },
  })

  Object.assign(ctx.remote, {
    $stream: <T,>(options: { open: (signal: AbortSignal) => AsyncIterable<T> }) => {
      const controller = new AbortController()
      const inner = options.open(controller.signal)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const value of inner) {
            yield { value, accept: () => {} }
          }
        },
        dispose: async () => { controller.abort() },
      }
    },
  })

  return {
    ctx,
    remote,
    streamControllers,
    startSignIn,
    cancelSignIn,
    reconnect,
    signOut,
  }
}

describe('ui-settings-parkwise', () => {
  it('exports an inert Host apply and declares expected client dependencies', () => {
    expect(() => { hostApply() }).not.toThrow()
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.parkwise', 'remoteAccess'])
    expect(Object.keys(en).length).toBe(Object.keys(zh).length)
  })

  it('registers plugins.item and settings.section, opens OAuth browser popup, and updates on stream events', async () => {
    const bench = makeBench()
    await bench.ctx.plugin(SlotRegistry).await()
    const slots = bench.ctx.get('slots') as SlotRegistry
    const locale = new LocaleRuntime(bench.ctx)
    locale.setLocale('zh')
    bench.ctx.provide('locale', locale)

    slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    const grantedActions = new Set(['parkwise/watch'])
    bench.ctx.provide('remoteAccess', {
      whenAccess(action: string, mount: () => (() => void) | Generator<() => void, void, unknown>) {
        if (!grantedActions.has(action)) return () => {}
        const result = mount()
        if (typeof result === 'function') return result
        const disposers: Array<() => void> = []
        let next = result.next()
        while (!next.done) {
          disposers.push(next.value)
          next = result.next()
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      },
    } as never)

    await bench.ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => {
      expect(slots.entries('plugins.item')).toHaveLength(1)
      expect(slots.entries('settings.section')).toHaveLength(1)
    })

    const pluginEntry = slots.entries('plugins.item')[0]!
    const settingsEntry = slots.entries('settings.section')[0]!
    expect(pluginEntry.options.id).toBe('parkwise')
    expect(settingsEntry.options.id).toBe('parkwise')
    expect(pluginEntry.locale).toBe(NS)
    expect(resolveSlotLabel(pluginEntry.options.label)).toBe(zh.title)
    expect(resolveSlotLabel(settingsEntry.options.label)).toBe(zh.nav)

    const face = injectedOf(settingsEntry)
    expect(ParkwisePluginCard({
      view: 'summary',
      t: tZh,
      ...(face),
    } as never)).toBe(zh.description)

    // Render settings view and feed initial signed-out stream snapshot.
    const useParkwise = bindSnapshotSelector(face.hooks.parkwise)
    const sectionProps: object = {
      ...face,
      close: vi.fn(),
      useParkwise,
      t: tZh,
    }
    render(<ParkwiseSettingsSection {...(sectionProps as ParkwiseSettingsSectionProps)} />)
    await vi.waitFor(() => { expect(bench.streamControllers).toHaveLength(1) })
    const stream = bench.streamControllers[0]!

    stream.push({ type: 'snapshot', state: makeSignedOutView() })
    await screen.findByText(zh.stateWaitingCredentials)

    // Click sign in -> pre-opens popup on Web, invokes startSignIn, and navigates popup once authorizeUrl arrives.
    const replaceSpy = vi.fn()
    const popup = { location: { replace: replaceSpy }, close: vi.fn(), closed: false }
    const openSpy = vi.fn(() => popup)
    vi.stubGlobal('open', openSpy)

    fireEvent.click(screen.getByRole('button', { name: zh.signInButton }))
    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(bench.startSignIn).toHaveBeenCalledWith(window.location.origin)
    })

    const authorizeUrl = 'https://kwzg.yizuw.cn/gw/oauth/authorize?client_id=deepseek-harness&state=s1'
    stream.push({
      type: 'credentials-changed',
      state: {
        ...makeSignedOutView(),
        attempt: {
          id: 'attempt-1' as never,
          phase: 'waiting-browser',
          authorizeUrl,
        },
      },
    })

    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith(authorizeUrl)
    })
    await screen.findByText(zh.waitingBrowser)
    expect(screen.getByRole('link', { name: zh.openAuthorizePage }).getAttribute('href')).toBe(authorizeUrl)

    // Complete login via stream update -> shows tenant badge, connected count, reconnect & sign out actions.
    stream.push({
      type: 'credentials-changed',
      state: {
        authStatus: 'credential-stored',
        serverName: 'parkwise',
        mcpUrl: 'https://kwzg.yizuw.cn/gw/mcp',
        oauthOrigin: 'https://kwzg.yizuw.cn',
        tenantSlug: 'demo-park',
        mcpState: 'connected',
        toolCount: 12,
        attempt: null,
      },
    })

    await screen.findByText('demo-park')
    await screen.findByText(tZh('stateConnected', { count: 12 }))

    fireEvent.click(screen.getByRole('button', { name: zh.reconnect }))
    await vi.waitFor(() => { expect(bench.reconnect).toHaveBeenCalledTimes(1) })
    const signOutBtn = screen.getByRole('button', { name: zh.signOut }) as HTMLButtonElement
    await vi.waitFor(() => { expect(signOutBtn.disabled).toBe(false) })

    fireEvent.click(signOutBtn)
    await vi.waitFor(() => { expect(bench.signOut).toHaveBeenCalledTimes(1) })

    await bench.ctx.fiber.dispose()
  })

  it('uses __DSH_TRANSPORT__.streamBaseUrl and shell window.open in Desktop mode', async () => {
    vi.stubGlobal('dshDesktop', {})
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:43210/stream' })
    const openSpy = vi.fn(() => null)
    vi.stubGlobal('open', openSpy)

    const bench = makeBench()
    await bench.ctx.plugin(SlotRegistry).await()
    const slots = bench.ctx.get('slots') as SlotRegistry
    const locale = new LocaleRuntime(bench.ctx)
    locale.setLocale('en')
    bench.ctx.provide('locale', locale)

    slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    bench.ctx.provide('remoteAccess', {
      whenAccess(_action: string, mount: () => (() => void) | Generator<() => void, void, unknown>) {
        const result = mount()
        if (typeof result === 'function') return result
        const disposers: Array<() => void> = []
        let next = result.next()
        while (!next.done) {
          disposers.push(next.value)
          next = result.next()
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      },
    } as never)

    await bench.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })

    const face = injectedOf(slots.entries('settings.section')[0]!)
    await vi.waitFor(() => { expect(bench.streamControllers).toHaveLength(1) })
    const stream = bench.streamControllers[0]!

    stream.push({ type: 'snapshot', state: makeSignedOutView() })
    await face.startSignIn()
    expect(bench.startSignIn).toHaveBeenCalledWith('http://127.0.0.1:43210')

    const desktopUrl = 'https://kwzg.yizuw.cn/gw/oauth/authorize?client_id=deepseek-harness&state=d1'
    stream.push({
      type: 'credentials-changed',
      state: {
        ...makeSignedOutView(),
        attempt: { id: 'attempt-1' as never, phase: 'waiting-browser', authorizeUrl: desktopUrl },
      },
    })

    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(desktopUrl, '_blank', 'noopener,noreferrer')
    })
    await bench.ctx.fiber.dispose()
  })

  it('registers the ParkWise seal settings icon and DSH × ParkWise sidebar co-brand', async () => {
    const bench = makeBench()
    await bench.ctx.plugin(SlotRegistry).await()
    const slots = bench.ctx.get('slots') as SlotRegistry
    const locale = new LocaleRuntime(bench.ctx)
    locale.setLocale('zh')
    bench.ctx.provide('locale', locale)

    slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
        'sidebar.brand.eyebrow': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)

    bench.ctx.provide('remoteAccess', {
      whenAccess(_action: string, mount: () => (() => void) | Generator<() => void, void, unknown>) {
        const result = mount()
        if (typeof result === 'function') return result
        const disposers: Array<() => void> = []
        let next = result.next()
        while (!next.done) {
          disposers.push(next.value)
          next = result.next()
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      },
    } as never)

    await bench.ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => {
      expect(slots.entries('settings.section.icon')).toHaveLength(1)
      expect(slots.entries('sidebar.brand.eyebrow')).toHaveLength(1)
      expect(slots.entries('sidebar.brand.name')).toHaveLength(1)
      expect(bench.streamControllers).toHaveLength(1)
    })

    const iconEntry = slots.entries('settings.section.icon')[0]!
    expect(iconEntry.options.id).toBe('parkwise')
    const Icon = iconEntry.component as (props: { size: number; active: boolean }) => ReactNode
    const { container: iconContainer } = render(<Icon size={18} active={false} />)
    expect(iconContainer.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(iconContainer.querySelector('rect')?.getAttribute('fill')).toBe('#9c3a2b')

    const brandEntry = slots.entries('sidebar.brand.name')[0]!
    const CoBrand = brandEntry.component as (props: { t: typeof tZh }) => ReactNode
    const { container: brandContainer } = render(<CoBrand t={tZh} />)
    expect(brandContainer.textContent).toContain('×')
    expect(brandContainer.textContent).toContain(zh.brandTitle)
    expect(brandContainer.querySelector('rect')?.getAttribute('fill')).toBe('#9c3a2b')

    const eyebrowEntry = slots.entries('sidebar.brand.eyebrow')[0]!
    const eyebrowFace = injectedOf(eyebrowEntry)
    const Eyebrow = eyebrowEntry.component as (props: Pick<ParkwiseBrandCompanyProps, 'useParkwise'>) => ReactNode
    const useParkwiseBrand = bindSnapshotSelector(eyebrowFace.hooks.parkwise)
    render(<Eyebrow useParkwise={useParkwiseBrand} />)
    expect(screen.queryByTestId('parkwise-co-brand-company')).toBeNull()

    const stream = bench.streamControllers[0]!
    stream.push({
      type: 'credentials-changed',
      state: {
        ...makeSignedOutView(),
        authStatus: 'credential-stored',
        tenantSlug: 'syxd',
        companyName: '十一兄弟实业有限公司',
        mcpState: 'connected',
        toolCount: 18,
      },
    })

    await vi.waitFor(() => {
      expect(screen.getByTestId('parkwise-co-brand-company').textContent).toBe('十一兄弟实业有限公司')
    })

    stream.push({ type: 'credentials-changed', state: makeSignedOutView() })
    await vi.waitFor(() => {
      expect(screen.queryByTestId('parkwise-co-brand-company')).toBeNull()
    })

    await bench.ctx.fiber.dispose()
  })

  it('registers settings.launcher.sublabel and renders ParkWise position and real name after authorization', async () => {
    const bench = makeBench()
    await bench.ctx.plugin(SlotRegistry).await()
    const slots = bench.ctx.get('slots') as SlotRegistry
    const locale = new LocaleRuntime(bench.ctx)
    locale.setLocale('zh')
    bench.ctx.provide('locale', locale)

    slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.launcher.sublabel': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)

    bench.ctx.provide('remoteAccess', {
      whenAccess(_action: string, mount: () => (() => void) | Generator<() => void, void, unknown>) {
        const result = mount()
        if (typeof result === 'function') return result
        const disposers: Array<() => void> = []
        let next = result.next()
        while (!next.done) {
          disposers.push(next.value)
          next = result.next()
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      },
    } as never)

    await bench.ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => {
      expect(slots.entries('settings.launcher.sublabel')).toHaveLength(1)
      expect(bench.streamControllers).toHaveLength(1)
    })

    const sublabelEntry = slots.entries('settings.launcher.sublabel')[0]!
    const sublabelFace = injectedOf(sublabelEntry)
    const Sublabel = sublabelEntry.component as (props: Pick<ParkwiseLauncherSublabelProps, 'wide' | 'useParkwise'>) => ReactNode
    const useParkwiseSublabel = bindSnapshotSelector(sublabelFace.hooks.parkwise)

    const view = render(<Sublabel wide useParkwise={useParkwiseSublabel} />)
    expect(screen.queryByTestId('parkwise-launcher-sublabel')).toBeNull()

    const stream = bench.streamControllers[0]!
    stream.push({ type: 'snapshot', state: makeSignedOutView() })
    expect(screen.queryByTestId('parkwise-launcher-sublabel')).toBeNull()

    stream.push({
      type: 'credentials-changed',
      state: {
        ...makeSignedOutView(),
        authStatus: 'credential-stored',
        tenantSlug: 'syxd',
        userName: '彭永杰',
        userPosition: '招商总监',
        roleNames: ['园区管理员'],
        mcpState: 'connected',
        toolCount: 18,
      },
    })

    await vi.waitFor(() => {
      expect(screen.getByTestId('parkwise-launcher-sublabel').textContent).toBe('招商总监 · 彭永杰')
    })

    view.rerender(<Sublabel wide={false} useParkwise={useParkwiseSublabel} />)
    expect(screen.queryByTestId('parkwise-launcher-sublabel')).toBeNull()

    stream.push({ type: 'credentials-changed', state: makeSignedOutView() })
    view.rerender(<Sublabel wide useParkwise={useParkwiseSublabel} />)
    await vi.waitFor(() => {
      expect(screen.queryByTestId('parkwise-launcher-sublabel')).toBeNull()
    })

    await bench.ctx.fiber.dispose()
  })
})
