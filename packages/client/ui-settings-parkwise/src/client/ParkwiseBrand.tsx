/** ParkWise brand lockup & settings navigation icon components. */

import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PluginArtworkParkwise } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ParkwiseCard.module.css'
import type { ParkwiseInjected } from './parkwise-store.ts'

/** Props for the ParkWise settings navigation icon (`settings.section.icon`). */
export type ParkwiseSectionIconProps = PropsRuntime<'settings.section.icon'>

/** Props for the authenticated enterprise eyebrow rendered above the sidebar brand icons. */
export type ParkwiseBrandCompanyProps = PropsRuntime<'sidebar.brand.eyebrow'> & InjectFace<ParkwiseInjected>

/** Props for the DSH × ParkWise co-brand title rendered beside the sidebar FishLogo mark. */
export type ParkwiseCoBrandNameProps = PropsRuntime<'sidebar.brand.name'> & PropsLocale<'settings.parkwise'>

/** Props for the bottom-left sidebar launcher subtitle showing ParkWise position and real name. */
export type ParkwiseLauncherSublabelProps = PropsRuntime<'settings.launcher.sublabel'> & InjectFace<ParkwiseInjected>

/**
 * Red-seal ParkWise logo icon rendered in the Settings navigation item.
 * @param props - Owner-supplied square edge size.
 * @returns the ParkWise seal SVG at the requested size.
 */
export function ParkwiseSectionIcon({ size }: ParkwiseSectionIconProps): ReactNode {
  return <PluginArtworkParkwise size={size} />
}

/**
 * Compact enterprise name rendered directly above the expanded sidebar brand icons, left-aligned
 * with the leading whale mark once ParkWise OAuth authorization has succeeded.
 * @param props - Injected ParkWise snapshot hook.
 * @returns left-aligned enterprise name caption or `null` when signed out.
 */
export function ParkwiseBrandCompany({ useParkwise }: ParkwiseBrandCompanyProps): ReactNode {
  const view = useParkwise(snapshot => snapshot.view)
  const companyName = view?.authStatus === 'credential-stored'
    ? (view.companyName?.trim() || view.tenantSlug?.trim() || undefined)
    : undefined
  if (companyName === undefined) return null
  return (
    <span className={css.coBrandEyebrow} title={companyName} data-testid="parkwise-co-brand-company">
      {companyName}
    </span>
  )
}

/**
 * Expanded sidebar co-brand title pairing DSH's leading whale mark with the ParkWise seal.
 * @param props - Locale reader bound to the `settings.parkwise` dictionary.
 * @returns the `×` separator, ParkWise red seal logo, and `DSH × 瞰维智管` wordmark.
 */
export function ParkwiseCoBrandName({ t }: ParkwiseCoBrandNameProps): ReactNode {
  return (
    <span className={css.coBrand} data-testid="parkwise-co-brand">
      <span className={css.coBrandDivider} aria-hidden="true">×</span>
      <PluginArtworkParkwise size={20} className={css.coBrandLogo} />
      <span className={css.coBrandTitle}>{t('brandTitle')}</span>
    </span>
  )
}

/**
 * Compact ParkWise member identity line (`position · real_name`) displayed under the
 * sidebar launcher name once ParkWise OAuth authorization has succeeded.
 * @param props - Expanded flag and injected ParkWise snapshot hook.
 * @returns subtle single-line text or `null` when signed out or unavailable.
 */
export function ParkwiseLauncherSublabel({ wide, useParkwise }: ParkwiseLauncherSublabelProps): ReactNode {
  const view = useParkwise(snapshot => snapshot.view)
  if (!wide || view?.authStatus !== 'credential-stored') return null
  const summary = [view.userPosition, view.userName]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join(' · ')
  if (!summary) return null
  return (
    <span className={css.launcherSublabel} title={summary} data-testid="parkwise-launcher-sublabel">
      {summary}
    </span>
  )
}
