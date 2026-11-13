/** ParkWise MCP connection & browser OAuth card shared across Settings and Plugins pages. */

import { useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, StateDot, Tag, writeClipboard, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ParkwiseAttemptView, ParkwiseStatusView } from '@deepseek-ai/dsh-parkwise-connector/types'
import css from './ParkwiseCard.module.css'
import type { ParkwiseSettingsLocaleKey } from './locales.ts'
import type { ParkwiseInjected } from './parkwise-store.ts'

/** Props for the Plugins official-item slot (`summary` or `page`). */
export type ParkwisePluginCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.parkwise'>
  & InjectFace<ParkwiseInjected>

/** Props for the Settings section slot (`settings.section`). */
export type ParkwiseSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.parkwise'>
  & InjectFace<ParkwiseInjected>

const DEFAULT_ENDPOINT_URL = 'https://kwzg.yizuw.cn/gw/mcp'

type Translate = (key: ParkwiseSettingsLocaleKey, params?: Record<string, string | number>) => string

function dotStateFor(view: ParkwiseStatusView | undefined, streamFailed: boolean): StateDotState {
  if (streamFailed) return 'error'
  if (view === undefined) return 'ongoing'
  switch (view.mcpState) {
    case 'connected':
      return 'done'
    case 'connecting':
    case 'reconnecting':
      return 'ongoing'
    case 'failed':
      return 'error'
    case 'waiting-credentials':
      return 'warning'
    case 'disabled':
      return 'idle'
  }
}

function statusTextFor(view: ParkwiseStatusView | undefined, streamFailed: boolean, t: Translate): string {
  if (streamFailed) return t('streamError')
  if (view === undefined) return t('stateLoading')
  switch (view.mcpState) {
    case 'connected':
      return t('stateConnected', { count: view.toolCount ?? 0 })
    case 'connecting':
      return t('stateConnecting')
    case 'reconnecting':
      return t('stateReconnecting')
    case 'waiting-credentials':
      return t('stateWaitingCredentials')
    case 'failed':
      return t('stateFailed', { error: view.mcpError ?? 'unknown' })
    case 'disabled':
      return t('stateDisabled')
  }
}

function attemptStatusText(attempt: ParkwiseAttemptView, t: Translate): string | undefined {
  switch (attempt.phase) {
    case 'initializing':
      return t('waitingInitializing')
    case 'waiting-browser':
      return t('waitingBrowser')
    case 'exchanging':
      return t('waitingExchanging')
    case 'committing':
      return t('waitingCommitting')
    case 'expired':
      return t('attemptExpired')
    case 'failed':
      return attempt.errorCode === 'access-denied'
        ? t('attemptDenied')
        : t('attemptFailed', { code: attempt.errorCode ?? 'protocol' })
    default:
      return undefined
  }
}

function isAttemptActive(attempt: ParkwiseAttemptView | null | undefined): attempt is ParkwiseAttemptView {
  return attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
}

function ParkwiseBody({
  t,
  useParkwise,
  startSignIn,
  cancelSignIn,
  reconnect,
  signOut,
}: Pick<ParkwiseSettingsSectionProps, 't' | 'useParkwise' | 'startSignIn' | 'cancelSignIn' | 'reconnect' | 'signOut'>): ReactNode {
  const { view, streamFailed, actionFailed, busy } = useParkwise(snapshot => snapshot)
  const [copied, setCopied] = useState(false)

  const attempt = view?.attempt ?? null
  const active = isAttemptActive(attempt)
  const signedIn = view?.authStatus === 'credential-stored'
  const authorizeUrl = attempt?.authorizeUrl

  useEffect(() => {
    setCopied(false)
  }, [attempt?.id, authorizeUrl])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copied])

  const dotState = dotStateFor(view, streamFailed)
  const mcpStatusText = statusTextFor(view, streamFailed, t)
  const attemptNotice = attempt !== null ? attemptStatusText(attempt, t) : undefined
  const attemptError = attempt !== null && (attempt.phase === 'failed' || attempt.phase === 'expired')

  const handleCopy = async (): Promise<void> => {
    if (!authorizeUrl) return
    await writeClipboard(authorizeUrl)
    setCopied(true)
  }

  return (
    <section className={css.section} aria-label={t('title')}>
      <div className={css.card}>
        <div className={css.header}>
          <div className={css.headerCopy}>
            <h4 className={css.title}>{t('authCardTitle')}</h4>
            <p className={css.hint}>{signedIn ? t('signedInHint') : t('signedOutHint')}</p>
          </div>
          <span className={css.statusBadge} role="status">
            <StateDot state={dotState} />
            <span>{mcpStatusText}</span>
          </span>
        </div>

        <div className={css.metaList}>
          {(view?.companyName || view?.tenantSlug) && (
            <div className={css.metaRow}>
              <span className={css.metaLabel}>{t('tenantLabel')}</span>
              <span className={css.metaValue}>
                <Tag tone="info">
                  {view.companyName && view.tenantSlug && view.companyName !== view.tenantSlug
                    ? `${view.companyName} (${view.tenantSlug})`
                    : (view.companyName ?? view.tenantSlug)}
                </Tag>
              </span>
            </div>
          )}
          {(view?.userName || view?.userPosition) && (
            <div className={css.metaRow}>
              <span className={css.metaLabel}>{t('accountLabel')}</span>
              <span className={css.metaValue}>
                {[view.userPosition, view.userName].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          <div className={css.metaRow}>
            <span className={css.metaLabel}>{t('endpointLabel')}</span>
            <span className={css.metaValue}>{view?.mcpUrl ?? DEFAULT_ENDPOINT_URL}</span>
          </div>
          <div className={css.metaRow}>
            <span className={css.metaLabel}>{t('skillLabel')}</span>
            <span className={css.metaValue}>
              <Tag tone="success">{t('skillActive')}</Tag>
            </span>
          </div>
        </div>

        {attemptNotice && (
          <p className={attemptError ? css.errorText : css.hint} role="status">
            {attemptNotice}
          </p>
        )}

        {(streamFailed || actionFailed) && !attemptError && (
          <p className={css.errorText} role="alert">{t('streamError')}</p>
        )}

        <div className={css.actions}>
          {!active && (
            <Button
              variant="primary"
              disabled={busy || view === undefined}
              onClick={() => { void startSignIn() }}
            >
              {signedIn ? t('reauthorizeButton') : t('signInButton')}
            </Button>
          )}
          {active && authorizeUrl && (
            <>
              <a
                className={css.linkButton}
                href={authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('openAuthorizePage')}
              </a>
              <Button
                variant="outline"
                onClick={() => { void handleCopy() }}
              >
                {copied ? t('copied') : t('copyAuthorizeUrl')}
              </Button>
            </>
          )}
          {isAttemptActive(attempt) && (
            <Button
              variant="outline"
              disabled={busy || attempt.phase === 'committing'}
              onClick={() => { void cancelSignIn(attempt.id) }}
            >
              {t('cancel')}
            </Button>
          )}
          {signedIn && !active && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => { void reconnect() }}
              >
                {t('reconnect')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => { void signOut() }}
              >
                {t('signOut')}
              </Button>
            </>
          )}
        </div>

        <p className={css.hint}>{t('oauthGuide')}</p>
      </div>
    </section>
  )
}

/**
 * Plugins page (`plugins.item`) card & detail view for ParkWise.
 * @param props - view selector (`summary` or `page`), locale reader, and injected Remote actions.
 */
export function ParkwisePluginCard(props: ParkwisePluginCardProps): ReactNode {
  if (props.view === 'summary') return props.t('description')
  return <ParkwiseBody {...props} />
}

/**
 * Settings modal (`settings.section`) view for ParkWise OAuth authorization & MCP status.
 * @param props - locale reader and injected Remote actions.
 */
export function ParkwiseSettingsSection(props: ParkwiseSettingsSectionProps): ReactNode {
  return <ParkwiseBody {...props} />
}
