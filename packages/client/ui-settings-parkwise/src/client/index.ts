/**
 * ParkWise settings & plugins page, browser half: streams live OAuth & MCP status
 * from `remote.parkwise.watch` and exposes browser OAuth login across both the
 * Settings navigation (`settings.section`) and Official Plugins (`plugins.item`).
 */

import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ParkwiseUpdate } from '@deepseek-ai/dsh-parkwise-connector/types'
import { ParkwisePluginCard, ParkwiseSettingsSection } from './ParkwiseCard.tsx'
import {
  ParkwiseBrandCompany,
  ParkwiseCoBrandName,
  ParkwiseLauncherSublabel,
  ParkwiseSectionIcon,
} from './ParkwiseBrand.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type ParkwiseSettingsLocaleKey } from './locales.ts'
import { createParkwiseStore } from './parkwise-store.ts'

export type { ParkwisePluginCardProps, ParkwiseSettingsSectionProps } from './ParkwiseCard.tsx'
export { ParkwisePluginCard, ParkwiseSettingsSection } from './ParkwiseCard.tsx'
export type {
  ParkwiseBrandCompanyProps,
  ParkwiseCoBrandNameProps,
  ParkwiseLauncherSublabelProps,
  ParkwiseSectionIconProps,
} from './ParkwiseBrand.tsx'
export {
  ParkwiseBrandCompany,
  ParkwiseCoBrandName,
  ParkwiseLauncherSublabel,
  ParkwiseSectionIcon,
} from './ParkwiseBrand.tsx'
export type { ParkwiseInjected, ParkwiseSnapshot } from './parkwise-store.ts'
export type { ParkwiseSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ParkWise MCP authorization and connection settings copy. */
    'settings.parkwise': ParkwiseSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.parkwise'

/** Required browser services. */
export const inject = ['slots', 'locale', 'remote', 'remote.parkwise', 'remoteAccess']

/**
 * Mount the ParkWise MCP authorization card into Settings and Plugins while `parkwise/watch` access holds.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-parkwise: dictionaries')

  const store = createParkwiseStore(ctx)
  ctx.effect(() => () => { store.dispose() }, 'ui-settings-parkwise: store lifetime')

  ctx.remoteAccess.whenAccess('parkwise/watch', function* () {
    const stream = ctx.remote.$stream<ParkwiseUpdate>({
      name: 'parkwise',
      open: signal => ctx.remote.parkwise.watch(signal),
      ended: () => new Error('parkwise stream ended'),
      carrierFailed: () => { store.markStreamFailed() },
    })
    store.attachStream(stream)
    yield () => {
      store.reset()
      return stream.dispose()
    }
  })

  ctx.remoteAccess.whenAccess('parkwise/watch', () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'parkwise',
    order: 15,
    label: () => t('title'),
    locale: NS,
    inject: () => store.face,
  }, ParkwisePluginCard)))

  ctx.remoteAccess.whenAccess('parkwise/watch', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'parkwise',
    order: 18,
    label: () => t('nav'),
    locale: NS,
    inject: () => store.face,
  }, ParkwiseSettingsSection)))
  ctx.remoteAccess.whenAccess('parkwise/watch', () => ctx.slots.inject('settings.launcher.sublabel', () => ctx.slots.register({
    name: 'settings.launcher.sublabel',
    inject: () => store.face,
  }, ParkwiseLauncherSublabel)))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'parkwise',
  }, ParkwiseSectionIcon))
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') {
    ctx.slots.inject('sidebar.brand.eyebrow', () => ctx.slots.register({
      name: 'sidebar.brand.eyebrow',
      inject: () => store.face,
    }, ParkwiseBrandCompany))
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
      name: 'sidebar.brand.name',
      locale: NS,
    }, ParkwiseCoBrandName))
  }
}
