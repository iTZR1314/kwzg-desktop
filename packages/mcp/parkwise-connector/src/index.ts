/**
 * Built-in ParkWise MCP connector (`ctx.parkwise`, Remote namespace `parkwise`):
 * registers the `parkwise` streamable-HTTP server in `ctx.mcpManager` using
 * `${credential:PARKWISE_MCP_TOKEN}`, drives browser OAuth 2.0 + PKCE (`S256`)
 * login over `ctx.webServer`, bundles `parkwise-skill` on `ctx.skills`, and
 * publishes default MCP workflow guidance on `ctx.systemPrompt`.
 *
 * @module @deepseek-ai/dsh-parkwise-connector
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  credentialKey, credentialRef, type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import {
  discoverOAuthServer,
  exchangeAuthorizationCode,
  extractTenantSlug,
  normalizeHttpUrl,
  PARKWISE_CALLBACK_PATH,
  PARKWISE_CLIENT_ID,
  PARKWISE_CLIENT_NAME,
  ParkwiseOAuthError,
  refreshAccessToken,
  renderCallbackHtml,
  sanitizedCompanyName,
  validateCallbackOrigin,
} from './oauth.ts'
import { fetchParkwiseSessionProfile } from './profile.ts'
import { registerSkillAndGuidance } from './skill.ts'
import type {
  ParkwiseAttemptId,
  ParkwiseAttemptView,
  ParkwiseErrorCode,
  ParkwiseMcpState,
  ParkwiseStatusView,
  ParkwiseUpdate,
} from './types.ts'

export type {
  ParkwiseAttemptId,
  ParkwiseAttemptView,
  ParkwiseErrorCode,
  ParkwiseMcpState,
  ParkwiseStatusView,
  ParkwiseUpdate,
} from './types.ts'
export { PARKWISE_CALLBACK_PATH, PARKWISE_CLIENT_ID, PARKWISE_CLIENT_NAME, ParkwiseOAuthError } from './oauth.ts'
export { PARKWISE_SKILL_NAME, parkwiseGuidanceText } from './skill.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Built-in ParkWise Smart Park MCP connector and OAuth manager. */
    parkwise: ParkwiseConnector
  }
}

const GRANT_KEY = credentialKey('parkwise-mcp', 'default')
const DEFAULT_MCP_URL = 'https://kwzg.yizuw.cn/gw/mcp'
const DEFAULT_OAUTH_ORIGIN = 'https://kwzg.yizuw.cn'
const DEFAULT_SCOPES = 'mcp:read mcp:write'
const DEFAULT_SERVER_NAME = 'parkwise'
const DEFAULT_CREDENTIAL_REF = 'PARKWISE_MCP_TOKEN'
const REFRESH_MARGIN_MS = 60_000

const GrantPayloadSchema = z.object({
  version: z.literal(1),
  issuer: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  tenantSlug: z.string().optional(),
  companyName: z.string().min(1).optional(),
  userName: z.string().min(1).optional(),
  userPosition: z.string().min(1).optional(),
  roleNames: z.array(z.string().min(1)).optional(),
})

type GrantPayload = z.infer<typeof GrantPayloadSchema>

/** Configuration options for {@link ParkwiseConnector}. */
export interface Config {
  /** ParkWise Streamable HTTP MCP endpoint URL. */
  mcpUrl?: string
  /** ParkWise OAuth 2.0 gateway origin. */
  oauthOrigin?: string
  /** Development opt-in allowing `http://` on loopback `mcpUrl` / `oauthOrigin`. */
  allowLoopbackHttp?: boolean
  /** OAuth scopes requested during authorization. */
  scopes?: string
  /** Registered MCP server name in `mcpManager` (tools appear as `mcp__<serverName>__*`). */
  serverName?: string
  /** Credential reference name read by MCP headers (`${credential:<ref>}`). */
  credentialRef?: string
  /** Whether to expose bundled `parkwise-skill` via `ctx.skills`. */
  enableSkill?: boolean
  /** Whether to register default ParkWise MCP tool usage guidance in `ctx.systemPrompt`. */
  enableGuidance?: boolean
  /** Optional override directory containing `SKILL.md` (for testing or custom assets). */
  skillDirectory?: string
  /** HTTP request timeout in milliseconds for OAuth discovery/token calls. */
  requestTimeoutMs?: number
  /** Total browser authorization attempt timeout in milliseconds. */
  attemptTimeoutMs?: number
}

/** Validated ParkWise connector configuration with defaults applied. */
export interface ResolvedConfig {
  readonly mcpUrl: string
  readonly oauthOrigin: string
  readonly allowLoopbackHttp: boolean
  readonly scopes: string
  readonly serverName: string
  readonly credentialRef: string
  readonly enableSkill: boolean
  readonly enableGuidance: boolean
  readonly skillDirectory?: string
  readonly requestTimeoutMs: number
  readonly attemptTimeoutMs: number
}

/** Schemastery config schema for Loader / profile configuration. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  mcpUrl: Schema.string().default(DEFAULT_MCP_URL),
  oauthOrigin: Schema.string().default(DEFAULT_OAUTH_ORIGIN),
  allowLoopbackHttp: Schema.boolean().default(false),
  scopes: Schema.string().default(DEFAULT_SCOPES),
  serverName: Schema.string().default(DEFAULT_SERVER_NAME),
  credentialRef: Schema.string().default(DEFAULT_CREDENTIAL_REF),
  enableSkill: Schema.boolean().default(true),
  enableGuidance: Schema.boolean().default(true),
  skillDirectory: Schema.string().min(1),
  requestTimeoutMs: Schema.number().min(100).max(120_000).default(15_000),
  attemptTimeoutMs: Schema.number().min(1_000).max(1_800_000).default(300_000),
})

interface CallbackHttpResponse {
  writeHead(statusCode: number, headers: Record<string, string>): CallbackHttpResponse
  end(chunk?: string): void
}

interface ActiveAttempt {
  readonly callbackOrigin: string
  readonly controller: AbortController
  view: ParkwiseAttemptView
  callbackResponse?: CallbackHttpResponse
  done: Promise<void>
}

/** Map a `mcp-manager` status union into the client-safe {@link ParkwiseMcpState} summary. */
function projectMcpStatus(status: McpManagedServerStatus | undefined): {
  mcpState: ParkwiseMcpState
  toolCount?: number
  mcpError?: string
} {
  if (status === undefined) return { mcpState: 'connecting' }
  switch (status.state) {
    case 'waiting-credentials':
      return { mcpState: 'waiting-credentials' }
    case 'connecting':
      return { mcpState: 'connecting' }
    case 'connected':
      return { mcpState: 'connected', toolCount: status.toolCount }
    case 'reconnecting':
      return { mcpState: 'reconnecting', mcpError: status.lastError }
    case 'failed': {
      const mcpError = status.reason === 'cleanup'
        ? status.result.cleanupError ?? 'cleanup incomplete'
        : status.lastError ?? status.reason
      return { mcpState: 'failed', mcpError }
    }
    case 'disabled':
    case 'closed':
      return { mcpState: 'disabled' }
  }
}

/**
 * Built-in ParkWise MCP connector and browser OAuth service.
 * Exposes `ctx.remote.parkwise` for Web and Desktop UIs.
 */
export class ParkwiseConnector extends TypertRemoteService {
  static inject = ['credentials', 'mcpManager']
  static Config = Config

  /** Resolved Streamable HTTP URL for the ParkWise MCP server. */
  readonly mcpUrl: string
  /** Origin of the ParkWise OAuth gateway. */
  readonly oauthOrigin: string
  private readonly allowLoopbackHttp: boolean
  private readonly scopes: string
  /** Registered MCP server name in `ctx.mcpManager`. */
  readonly serverName: string
  private readonly credRefName: string
  private readonly credRef: CredentialRef
  private readonly requestTimeoutMs: number
  private readonly attemptTimeoutMs: number

  private attempt: ActiveAttempt | undefined
  private storedAuthorized = false
  private closed = false
  private lifetime = new AbortController()
  private readonly listeners = new Set<(kind: ParkwiseUpdate['type']) => void>()
  private unregisterMcp: (() => void) | undefined

  /**
   * @param ctx - Host plugin context carrying `credentials` and `mcpManager`.
   * @param rawConfig - deployment or profile configuration.
   */
  constructor(ctx: Context, rawConfig: Config = {}) {
    super(ctx, 'parkwise', { namespace: 'parkwise' })
    const config = Config(rawConfig)
    this.allowLoopbackHttp = config.allowLoopbackHttp
    this.mcpUrl = normalizeHttpUrl(config.mcpUrl, config.allowLoopbackHttp, 'mcpUrl')
    this.oauthOrigin = new URL(normalizeHttpUrl(config.oauthOrigin, config.allowLoopbackHttp, 'oauthOrigin')).origin
    this.scopes = config.scopes.trim() || DEFAULT_SCOPES
    this.serverName = config.serverName.trim() || DEFAULT_SERVER_NAME
    this.credRefName = config.credentialRef.trim() || DEFAULT_CREDENTIAL_REF
    this.credRef = credentialRef(this.credRefName)
    this.requestTimeoutMs = config.requestTimeoutMs
    this.attemptTimeoutMs = config.attemptTimeoutMs

    registerSkillAndGuidance(ctx, {
      serverName: this.serverName,
      enableSkill: config.enableSkill,
      enableGuidance: config.enableGuidance,
      ...config.skillDirectory === undefined ? {} : { skillDirectory: config.skillDirectory },
      isAuthorized: () => this.storedAuthorized,
    })

    ctx.on('credentials/record-updated', (key) => {
      if (key !== GRANT_KEY) return
      void this.syncAuthorizedFlag().then(() => {
        this.notify('credentials-changed')
      })
    })

    ctx.on('credentials/reference-updated', (ref) => {
      if (ref !== this.credRef) return
      void this.syncAuthorizedFlag().then(() => {
        this.notify('credentials-changed')
      })
    })

    ctx.on('mcp-manager/status', (name) => {
      if (name !== this.serverName) return
      this.notify('mcp-changed')
    })

    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      if (this.attempt !== undefined) {
        this.attempt.controller.abort()
        await this.attempt.done.catch(() => undefined)
      }
      this.unregisterMcp?.()
      this.unregisterMcp = undefined
      this.notify('snapshot')
    }, 'parkwise: service lifetime')
  }

  /** Sync any stored grant on startup and register the built-in `parkwise` MCP server. */
  async [Service.init](): Promise<void> {
    await this.restoreStoredGrant()
    await this.syncAuthorizedFlag()
    if (this.closed) return
    this.unregisterMcp = this.ctx.mcpManager.register(this.serverName, {
      transport: 'streamable-http',
      url: this.mcpUrl,
      headers: {
        Authorization: `Bearer \${credential:${this.credRefName}}`,
      },
    })
    this.notify('snapshot')
  }

  /**
   * Read the current sanitized ParkWise authentication & MCP status snapshot.
   * @returns snapshot safe for Browser/Desktop UIs without secret tokens.
   */
  @Remote
  async getState(): Promise<ParkwiseStatusView> {
    const [record, refInfo, mcpEntries] = await Promise.all([
      this.ctx.credentials.readRecord(GRANT_KEY),
      this.ctx.credentials.describe(this.credRef),
      Promise.resolve(this.ctx.mcpManager.list()),
    ])

    let grant: GrantPayload | undefined
    if (record?.kind === 'grant') {
      const parsed = GrantPayloadSchema.safeParse(record.payload)
      if (parsed.success && parsed.data.issuer === this.oauthOrigin) {
        grant = parsed.data
      }
    }

    const authStatus = grant !== undefined || refInfo.configured ? 'credential-stored' : 'signed-out'
    this.storedAuthorized = authStatus === 'credential-stored'

    const managed = mcpEntries.find(entry => entry.name === this.serverName)
    const mcp = projectMcpStatus(managed?.status)

    const attempt = this.attempt?.view ?? null
    const companyName = sanitizedCompanyName(grant?.companyName)
    return {
      authStatus,
      serverName: this.serverName,
      mcpUrl: this.mcpUrl,
      oauthOrigin: this.oauthOrigin,
      ...grant?.tenantSlug === undefined ? {} : { tenantSlug: grant.tenantSlug },
      ...companyName === undefined ? {} : { companyName },
      ...grant?.userName === undefined ? {} : { userName: grant.userName },
      ...grant?.userPosition === undefined ? {} : { userPosition: grant.userPosition },
      ...grant?.roleNames === undefined ? {} : { roleNames: grant.roleNames },
      ...grant?.scope === undefined ? {} : { scope: grant.scope },
      ...grant?.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt },
      ...mcp,
      attempt: authStatus === 'signed-out' && attempt?.phase === 'succeeded' ? null : attempt,
    }
  }

  /**
   * Start or join a browser OAuth 2.0 + PKCE (`S256`) sign-in attempt.
   * Registers an ephemeral callback route on `ctx.webServer` and returns the authorize URL
   * in `attempt.authorizeUrl` as soon as metadata discovery completes.
   * @param callbackOrigin - browser-accessible loopback HTTP(S) origin where `webServer` listens.
   * @returns initial attempt state (waiting-browser once URL is built).
   */
  @Remote
  async startSignIn(callbackOrigin: string): Promise<ParkwiseStatusView> {
    if (this.closed) throw new ParkwiseOAuthError('protocol', 'connector is disposed')
    const origin = validateCallbackOrigin(callbackOrigin)
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new ParkwiseOAuthError('protocol', 'webServer service is unavailable')

    if (
      this.attempt !== undefined
      && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(this.attempt.view.phase)
    ) {
      return this.getState()
    }

    const attempt: ActiveAttempt = {
      callbackOrigin: origin,
      controller: new AbortController(),
      view: {
        id: randomUUID() as ParkwiseAttemptId,
        phase: 'initializing',
      },
      done: Promise.resolve(),
    }
    this.attempt = attempt

    const runPromise = this.runOAuthAttempt(attempt)
    attempt.done = runPromise.catch(() => undefined)
    // Allow immediate waiting-browser transition if discovery is local/fast;
    // return promptly when discovery involves network so BrowserLogin popup doesn't wait unnecessarily.
    await Promise.race([
      runPromise.catch(() => undefined),
      new Promise<void>((resolve) => { setTimeout(resolve, 150) }),
    ])
    this.notify('snapshot')
    return this.getState()
  }

  /**
   * Cancel an active ParkWise browser OAuth attempt by id.
   * @param attemptId - identifier of the active attempt.
   * @returns latest connection view.
   */
  @Remote
  async cancelSignIn(attemptId: ParkwiseAttemptId): Promise<ParkwiseStatusView> {
    const attempt = this.attempt
    if (attempt !== undefined && attempt.view.id === attemptId) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.updateAttempt(attempt, { phase: 'cancelled' })
      }
      await attempt.done
    }
    return this.getState()
  }

  /**
   * Refresh the OAuth token if a refresh token is stored and expired/expiring, then restart
   * the managed `parkwise` MCP connection so tools re-sync cleanly.
   * @returns latest connection view.
   */
  @Remote
  async reconnect(): Promise<ParkwiseStatusView> {
    if (this.closed) throw new ParkwiseOAuthError('protocol', 'connector is disposed')
    await this.refreshIfNeeded(true)
    await this.ctx.mcpManager.restart(this.serverName)
    await this.refreshSessionProfile()
    this.notify('mcp-changed')
    return this.getState()
  }

  /**
   * Clear local ParkWise OAuth grant and unset the MCP credential reference so MCP tools withdraw cleanly.
   * @returns signed-out status view.
   */
  @Remote
  async signOut(): Promise<ParkwiseStatusView> {
    if (this.closed) throw new ParkwiseOAuthError('protocol', 'connector is disposed')
    if (this.attempt !== undefined) {
      await this.cancelSignIn(this.attempt.view.id)
    }
    this.attempt = undefined
    this.storedAuthorized = false
    await Promise.all([
      this.ctx.credentials.deleteRecord(GRANT_KEY),
      this.ctx.credentials.unset(this.credRef),
    ])
    this.notify('credentials-changed')
    return this.getState()
  }

  /**
   * Stream ordered ParkWise status snapshots whenever OAuth progress, credentials, or MCP status changes.
   * @param signal - subscriber abort signal.
   * @returns live status frames until cancelled or disposed.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<ParkwiseUpdate> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    let pending: ParkwiseUpdate['type'] | undefined = 'snapshot'
    let wake: (() => void) | undefined

    const listener = (kind: ParkwiseUpdate['type']): void => {
      if (kind === 'credentials-changed' || pending === undefined) {
        pending = kind === 'credentials-changed' ? 'credentials-changed' : kind
      }
      wake?.()
    }
    const onAbort = (): void => { wake?.() }
    this.listeners.add(listener)
    lifetime.addEventListener('abort', onAbort, { once: true })

    try {
      while (!this.isStopped(lifetime)) {
        if (pending !== undefined) {
          const type = pending
          pending = undefined
          const state = await this.getState()
          if (this.isStopped(lifetime)) break
          yield { type, state }
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.listeners.delete(listener)
      lifetime.removeEventListener('abort', onAbort)
    }
  }

  private isStopped(signal: AbortSignal): boolean {
    return this.closed || signal.aborted
  }

  private async runOAuthAttempt(attempt: ActiveAttempt): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new ParkwiseOAuthError('protocol')

    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const callbackResult = Promise.withResolvers<{ code: string; res: CallbackHttpResponse }>()
    void callbackResult.promise.catch(() => undefined)

    const deadline = new AbortController()
    const expiresAt = Date.now() + this.attemptTimeoutMs
    const signal = AbortSignal.any([this.lifetime.signal, attempt.controller.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, this.attemptTimeoutMs)
    const onAbort = (): void => {
      callbackResult.reject(new ParkwiseOAuthError(deadline.signal.aborted ? 'expired' : 'protocol'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let disposeRoute: (() => Promise<void>) | undefined
    try {
      disposeRoute = this.ctx.effect(() => webServer.register({
        kind: 'exact',
        path: PARKWISE_CALLBACK_PATH,
        handler: (req, res) => {
          let url: URL
          try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1')
          } catch {
            res.writeHead(400, { 'cache-control': 'no-store' }).end('Invalid callback URL')
            return
          }
          if (req.method !== 'GET' || url.pathname !== PARKWISE_CALLBACK_PATH) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end()
            return
          }
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (!validState || url.searchParams.getAll('state').length !== 1) {
            const { html, nonce } = renderCallbackHtml(false, '无效的 OAuth state 校验参数')
            sendHtml(res, 400, html, nonce)
            return
          }
          const oauthError = url.searchParams.get('error')
          if (oauthError !== null) {
            const detail = url.searchParams.get('error_description') ?? oauthError
            const { html, nonce } = renderCallbackHtml(false, detail)
            sendHtml(res, 200, html, nonce)
            callbackResult.reject(new ParkwiseOAuthError(oauthError === 'access_denied' ? 'access-denied' : 'protocol', detail))
            return
          }
          const code = url.searchParams.get('code')
          if (!code || url.searchParams.getAll('code').length !== 1) {
            const { html, nonce } = renderCallbackHtml(false, '回调缺少授权码 code')
            sendHtml(res, 400, html, nonce)
            return
          }
          if (signal.aborted || attempt.callbackResponse !== undefined || attempt.view.phase !== 'waiting-browser') {
            const { html, nonce } = renderCallbackHtml(false, '本次授权已结束或超时，请重新发起')
            sendHtml(res, 410, html, nonce)
            return
          }
          attempt.callbackResponse = res
          callbackResult.resolve({ code, res })
        },
      }), 'parkwise: oauth callback route')

      const metadata = await discoverOAuthServer(
        this.oauthOrigin,
        this.allowLoopbackHttp,
        AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      )
      signal.throwIfAborted()

      const redirectUri = `${attempt.callbackOrigin}${PARKWISE_CALLBACK_PATH}`
      const authorize = new URL(metadata.authorizationEndpoint)
      authorize.searchParams.set('client_id', PARKWISE_CLIENT_ID)
      authorize.searchParams.set('client_name', PARKWISE_CLIENT_NAME)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('scope', this.scopes)
      authorize.searchParams.set('state', state)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')

      this.updateAttempt(attempt, {
        phase: 'waiting-browser',
        authorizeUrl: authorize.href,
        expiresAt,
      })

      const { code, res } = await callbackResult.promise
      signal.throwIfAborted()

      this.updateAttempt(attempt, { phase: 'exchanging' })
      const tokenResult = await exchangeAuthorizationCode({
        tokenEndpoint: metadata.tokenEndpoint,
        code,
        redirectUri,
        codeVerifier: verifier,
        clientId: PARKWISE_CLIENT_ID,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      })
      signal.throwIfAborted()

      this.updateAttempt(attempt, { phase: 'committing' })
      await this.commitGrant(tokenResult, false)
      await this.refreshSessionProfile(tokenResult.accessToken, signal)

      const slug = tokenResult.tenantSlug ?? extractTenantSlug(tokenResult.accessToken)
      const { html, nonce } = renderCallbackHtml(true, slug ? `当前授权企业：${slug}` : '授权凭据已生效')
      sendHtml(res, 200, html, nonce)

      this.updateAttempt(attempt, { phase: 'succeeded' })
      this.notify('credentials-changed')
    } catch (error) {
      if (attempt.controller.signal.aborted && !deadline.signal.aborted) {
        this.updateAttempt(attempt, { phase: 'cancelled' })
        return
      }
      const code = classifyErrorCode(error, deadline.signal.aborted)
      if (attempt.callbackResponse !== undefined) {
        const { html, nonce } = renderCallbackHtml(false, `授权失败 (${code})`)
        sendHtml(attempt.callbackResponse, 200, html, nonce)
      }
      this.updateAttempt(attempt, {
        phase: code === 'expired' ? 'expired' : 'failed',
        errorCode: code,
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      await disposeRoute?.()
    }
  }

  private async commitGrant(tokenResult: {
    readonly accessToken: string
    readonly refreshToken?: string
    readonly expiresIn?: number
    readonly scope?: string
    readonly tenantName?: string
    readonly tenantSlug?: string
  }, preserveProfile = true): Promise<void> {
    const tenantSlug = tokenResult.tenantSlug ?? extractTenantSlug(tokenResult.accessToken)
    const expiresAt = tokenResult.expiresIn === undefined
      ? undefined
      : Date.now() + tokenResult.expiresIn * 1000
    try {
      await this.ctx.credentials.modifyRecord(GRANT_KEY, (current) => {
        const existing = preserveProfile && current?.kind === 'grant'
          ? GrantPayloadSchema.safeParse(current.payload)
          : undefined
        const previous = existing?.success && existing.data.issuer === this.oauthOrigin
          ? existing.data
          : undefined
        const companyName = sanitizedCompanyName(tokenResult.tenantName)
          ?? (preserveProfile ? sanitizedCompanyName(previous?.companyName) : undefined)
        const payload: GrantPayload = {
          version: 1,
          issuer: this.oauthOrigin,
          accessToken: tokenResult.accessToken,
          ...tokenResult.refreshToken === undefined ? {} : { refreshToken: tokenResult.refreshToken },
          ...expiresAt === undefined ? {} : { expiresAt },
          ...tokenResult.scope === undefined ? {} : { scope: tokenResult.scope },
          ...tenantSlug === undefined ? {} : { tenantSlug },
          ...companyName === undefined ? {} : { companyName },
          ...previous?.userName === undefined ? {} : { userName: previous.userName },
          ...previous?.userPosition === undefined ? {} : { userPosition: previous.userPosition },
          ...previous?.roleNames === undefined ? {} : { roleNames: previous.roleNames },
        }
        return Promise.resolve({
          kind: 'grant',
          payload,
        })
      })
      await this.ctx.credentials.set(this.credRef, tokenResult.accessToken)
      this.storedAuthorized = true
    } catch {
      throw new ParkwiseOAuthError('storage')
    }
  }

  private async restoreStoredGrant(): Promise<void> {
    const record = await this.ctx.credentials.readRecord(GRANT_KEY)
    if (record === undefined) return
    if (record.kind !== 'grant') return
    const parsed = GrantPayloadSchema.safeParse(record.payload)
    if (!parsed.success || parsed.data.issuer !== this.oauthOrigin) {
      await this.ctx.credentials.deleteRecord(GRANT_KEY)
      await this.ctx.credentials.unset(this.credRef)
      return
    }
    const existing = await this.ctx.credentials.resolve(this.credRef)
    if (existing?.value !== parsed.data.accessToken) {
      await this.ctx.credentials.set(this.credRef, parsed.data.accessToken)
    }
    await this.refreshIfNeeded(false)
    void this.refreshSessionProfile()
  }

  private async refreshSessionProfile(accessToken?: string, parentSignal?: AbortSignal): Promise<void> {
    if (this.closed) return
    const record = await this.ctx.credentials.readRecord(GRANT_KEY)
    if (record?.kind !== 'grant') return
    const parsed = GrantPayloadSchema.safeParse(record.payload)
    if (!parsed.success || parsed.data.issuer !== this.oauthOrigin) return
    const token = accessToken ?? parsed.data.accessToken
    const timeoutSignal = AbortSignal.timeout(Math.min(this.requestTimeoutMs, 5_000))
    const signal = parentSignal === undefined
      ? AbortSignal.any([this.lifetime.signal, timeoutSignal])
      : AbortSignal.any([this.lifetime.signal, parentSignal, timeoutSignal])

    const profile = await fetchParkwiseSessionProfile({
      mcpUrl: this.mcpUrl,
      oauthOrigin: this.oauthOrigin,
      accessToken: token,
      signal,
    })
    if (profile === undefined || this.isStopped(signal)) return
    const resolvedCompanyName = sanitizedCompanyName(profile.companyName)
    const alreadyCurrent = resolvedCompanyName === parsed.data.companyName
      && profile.userName === parsed.data.userName
      && profile.userPosition === parsed.data.userPosition
      && JSON.stringify(profile.roleNames ?? []) === JSON.stringify(parsed.data.roleNames ?? [])
    if (alreadyCurrent) return

    let applied = false
    await this.ctx.credentials.modifyRecord(GRANT_KEY, (current) => {
      if (current?.kind !== 'grant') return Promise.resolve(current)
      const latest = GrantPayloadSchema.safeParse(current.payload)
      if (!latest.success || latest.data.issuer !== this.oauthOrigin || latest.data.accessToken !== token) {
        return Promise.resolve(current)
      }
      const { companyName: _staleCompany, ...restLatest } = latest.data
      const nextPayload: GrantPayload = {
        ...restLatest,
        ...resolvedCompanyName === undefined ? {} : { companyName: resolvedCompanyName },
        ...profile.userName === undefined ? {} : { userName: profile.userName },
        ...profile.userPosition === undefined ? {} : { userPosition: profile.userPosition },
        ...profile.roleNames === undefined ? {} : { roleNames: [...profile.roleNames] },
      }
      if (
        nextPayload.companyName === latest.data.companyName
        && nextPayload.userName === latest.data.userName
        && nextPayload.userPosition === latest.data.userPosition
        && JSON.stringify(nextPayload.roleNames ?? []) === JSON.stringify(latest.data.roleNames ?? [])
      ) {
        return Promise.resolve(current)
      }
      applied = true
      return Promise.resolve({ kind: 'grant' as const, payload: nextPayload })
    }).catch(() => undefined)

    if ((applied as boolean) && !this.isStopped(signal)) {
      this.notify('credentials-changed')
    }
  }

  private async refreshIfNeeded(force: boolean): Promise<void> {
    const record = await this.ctx.credentials.readRecord(GRANT_KEY)
    if (record?.kind !== 'grant') return
    const parsed = GrantPayloadSchema.safeParse(record.payload)
    if (!parsed.success || parsed.data.issuer !== this.oauthOrigin) return
    const { refreshToken, expiresAt } = parsed.data
    if (refreshToken === undefined) return
    if (!force && (expiresAt === undefined || expiresAt - Date.now() > REFRESH_MARGIN_MS)) return

    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.requestTimeoutMs)])
      const metadata = await discoverOAuthServer(this.oauthOrigin, this.allowLoopbackHttp, signal)
      const renewed = await refreshAccessToken({
        tokenEndpoint: metadata.tokenEndpoint,
        refreshToken,
        clientId: PARKWISE_CLIENT_ID,
        signal,
      })
      await this.commitGrant({
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken ?? refreshToken,
        ...renewed.expiresIn === undefined ? {} : { expiresIn: renewed.expiresIn },
        ...renewed.scope === undefined && parsed.data.scope !== undefined
          ? { scope: parsed.data.scope }
          : renewed.scope === undefined ? {} : { scope: renewed.scope },
      })
    } catch {
      // Keep existing grant if refresh temporarily fails (e.g. offline); user can re-authorize if rejected.
    }
  }

  private async syncAuthorizedFlag(): Promise<void> {
    const [record, refInfo] = await Promise.all([
      this.ctx.credentials.readRecord(GRANT_KEY),
      this.ctx.credentials.describe(this.credRef),
    ])
    const hasGrant = record?.kind === 'grant'
      && GrantPayloadSchema.safeParse(record.payload).success
      && GrantPayloadSchema.parse(record.payload).issuer === this.oauthOrigin
    this.storedAuthorized = hasGrant || refInfo.configured
  }

  private updateAttempt(attempt: ActiveAttempt, next: Partial<ParkwiseAttemptView>): void {
    const { authorizeUrl: _previousUrl, ...rest } = attempt.view
    attempt.view = {
      ...rest,
      ...next,
    }
    this.notify('snapshot')
  }

  private notify(kind: ParkwiseUpdate['type']): void {
    for (const listener of this.listeners) listener(kind)
  }
}

export default ParkwiseConnector

function sendHtml(res: CallbackHttpResponse, status: number, html: string, nonce: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
  }).end(html)
}

function classifyErrorCode(error: unknown, timedOut: boolean): ParkwiseErrorCode {
  if (error instanceof ParkwiseOAuthError) return error.code
  if (timedOut) return 'expired'
  return 'protocol'
}
