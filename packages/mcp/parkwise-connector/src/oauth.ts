/** ParkWise OAuth 2.0 + PKCE discovery, token exchange/refresh, origin validation, and callback page rendering. */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ParkwiseErrorCode } from './types.ts'

/** Default ParkWise gateway client id sent on authorize and token requests. */
export const PARKWISE_CLIENT_ID = 'deepseek-harness'

/** Display name sent to `/gw/oauth/authorize` (`ALLOWED_CLIENT_NAMES` in ParkWise gateway). */
export const PARKWISE_CLIENT_NAME = 'DeepSeek Harness'

/** Callback route path registered on the Host webserver during active OAuth attempts. */
export const PARKWISE_CALLBACK_PATH = '/oauth/parkwise/callback'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Typed error carrying a sanitized failure code without leaking tokens or URLs. */
export class ParkwiseOAuthError extends Error {
  /** @param code - safe error code suitable for Client localization. */
  constructor(readonly code: ParkwiseErrorCode, message?: string) {
    super(message ?? `parkwise-oauth: ${code}`)
    this.name = 'ParkwiseOAuthError'
  }
}

/** Validated OAuth authorization server endpoints derived from metadata or gateway defaults. */
export interface DiscoveredOAuthServer {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
}

/** Filter out SpacetimeDB's built-in default `public` customer placeholder so it never poses as a company name. */
export function sanitizedCompanyName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '公共空间') return undefined
  return trimmed
}

/** Validated OAuth token response returned by `/gw/oauth/token`. */
export interface OAuthTokenResult {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresIn?: number
  readonly scope?: string
  readonly tenantName?: string
  readonly tenantSlug?: string
}

const MetadataSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
})

const TokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  tenant_name: z.string().optional(),
  company_name: z.string().optional(),
  tenant_slug: z.string().optional(),
})

const OAuthErrorBodySchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
})

/**
 * Validate a configured HTTP(S) URL with optional loopback HTTP opt-in.
 * @param raw - user or deployment supplied URL string.
 * @param allowLoopbackHttp - permit `http://` when host is loopback.
 * @param field - field label included in validation errors.
 * @returns normalized URL string.
 */
export function normalizeHttpUrl(raw: string, allowLoopbackHttp: boolean, field: string): string {
  const url = new URL(raw)
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (
    url.username
    || url.password
    || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))
  ) {
    throw new Error(`parkwise: ${field} must use https:// (or http:// on loopback when allowLoopbackHttp is enabled)`)
  }
  return url.href
}

/**
 * Validate the browser-accessible callback origin passed by the UI when starting OAuth.
 * Accepts loopback HTTP/HTTPS origins so ParkWise gateway's RFC 8252 redirect policy matches.
 * @param rawOrigin - `window.location.origin` or Desktop transport origin.
 * @returns normalized origin without path, query, or fragment.
 */
export function validateCallbackOrigin(rawOrigin: string): string {
  let url: URL
  try {
    url = new URL(rawOrigin)
  } catch {
    throw new ParkwiseOAuthError('protocol', 'invalid callback origin')
  }
  const allowedProtocol = url.protocol === 'http:' || url.protocol === 'https:'
  if (
    !allowedProtocol
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new ParkwiseOAuthError('protocol', 'callback origin must be a loopback http(s) origin')
  }
  return url.origin
}

/**
 * Extract the non-secret enterprise slug prefix from a `{slug}.{jwt}` ParkWise gateway token.
 * @param accessToken - composite gateway bearer token.
 * @returns tenant slug if present, otherwise `undefined`.
 */
export function extractTenantSlug(accessToken: string): string | undefined {
  const match = /^([^.\s]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(accessToken)
  return match?.[1]
}

/**
 * Discover OAuth endpoints from `/.well-known/oauth-authorization-server` on `oauthOrigin`,
 * falling back to ParkWise gateway defaults (`/gw/oauth/authorize`, `/gw/oauth/token`) if metadata
 * is absent, while rejecting cross-origin or insecure endpoint redirection.
 * @param oauthOrigin - validated ParkWise gateway origin.
 * @param allowLoopbackHttp - permit loopback `http://` endpoints.
 * @param signal - abort signal for discovery request.
 * @returns validated authorization and token endpoint URLs.
 */
export async function discoverOAuthServer(
  oauthOrigin: string,
  allowLoopbackHttp: boolean,
  signal: AbortSignal,
): Promise<DiscoveredOAuthServer> {
  const defaults: DiscoveredOAuthServer = {
    authorizationEndpoint: new URL('/gw/oauth/authorize', oauthOrigin).href,
    tokenEndpoint: new URL('/gw/oauth/token', oauthOrigin).href,
  }
  try {
    const response = await fetch(new URL('/.well-known/oauth-authorization-server', oauthOrigin).href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return defaults
    }
    const raw: unknown = await response.json()
    const parsed = MetadataSchema.safeParse(raw)
    if (!parsed.success) return defaults
    const authUrl = new URL(normalizeHttpUrl(parsed.data.authorization_endpoint, allowLoopbackHttp, 'authorization_endpoint'))
    const tokenUrl = new URL(normalizeHttpUrl(parsed.data.token_endpoint, allowLoopbackHttp, 'token_endpoint'))
    if (authUrl.origin !== oauthOrigin || tokenUrl.origin !== oauthOrigin) {
      throw new ParkwiseOAuthError('protocol', 'OAuth metadata endpoints must stay on oauthOrigin')
    }
    return {
      authorizationEndpoint: authUrl.href,
      tokenEndpoint: tokenUrl.href,
    }
  } catch (error) {
    if (error instanceof ParkwiseOAuthError) throw error
    if (signal.aborted) throw error
    return defaults
  }
}

/**
 * Exchange an authorization code + PKCE `code_verifier` at the ParkWise token endpoint.
 * @param params - exchange parameters.
 * @returns validated access token and optional refresh token / TTL / scope.
 */
export async function exchangeAuthorizationCode(params: {
  tokenEndpoint: string
  code: string
  redirectUri: string
  codeVerifier: string
  clientId?: string
  signal: AbortSignal
}): Promise<OAuthTokenResult> {
  return postTokenRequest(params.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.clientId ?? PARKWISE_CLIENT_ID,
  }, params.signal)
}

/**
 * Refresh an existing ParkWise gateway access token using `grant_type=refresh_token`.
 * @param params - refresh request parameters.
 * @returns new access token and rotated/retained refresh token.
 */
export async function refreshAccessToken(params: {
  tokenEndpoint: string
  refreshToken: string
  clientId?: string
  signal: AbortSignal
}): Promise<OAuthTokenResult> {
  return postTokenRequest(params.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId ?? PARKWISE_CLIENT_ID,
  }, params.signal)
}

async function postTokenRequest(
  tokenEndpoint: string,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<OAuthTokenResult> {
  let response: Response
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal,
    })
  } catch {
    throw new ParkwiseOAuthError(signal.aborted ? 'expired' : 'no-response')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ParkwiseOAuthError(response.ok ? 'protocol' : 'network')
  }

  if (!response.ok) {
    const err = OAuthErrorBodySchema.safeParse(body)
    if (err.success && (err.data.error === 'invalid_grant' || err.data.error === 'expired_token')) {
      throw new ParkwiseOAuthError('expired')
    }
    throw new ParkwiseOAuthError(response.status === 400 ? 'protocol' : 'network')
  }

  const parsed = TokenSuccessSchema.safeParse(body)
  if (!parsed.success) throw new ParkwiseOAuthError('protocol')
  const tenantName = sanitizedCompanyName(parsed.data.tenant_name) ?? sanitizedCompanyName(parsed.data.company_name)
  const rawSlug = parsed.data.tenant_slug?.trim()
  const tenantSlug = rawSlug !== undefined && rawSlug.length > 0 ? rawSlug : undefined
  return {
    accessToken: parsed.data.access_token,
    ...parsed.data.refresh_token === undefined ? {} : { refreshToken: parsed.data.refresh_token },
    ...parsed.data.expires_in === undefined ? {} : { expiresIn: parsed.data.expires_in },
    ...parsed.data.scope === undefined ? {} : { scope: parsed.data.scope },
    ...tenantName === undefined ? {} : { tenantName },
    ...tenantSlug === undefined ? {} : { tenantSlug },
  }
}

/**
 * Render a CSP-hardened self-closing completion page for the system browser / popup callback tab.
 * @param ok - true for completed authorization, false for failure or denial.
 * @param detail - short status message already safe for HTML text rendering.
 * @returns HTML document string and matching CSP nonce.
 */
export function renderCallbackHtml(ok: boolean, detail: string): { html: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const title = ok ? '瞰维智管 · 授权成功' : '瞰维智管 · 授权未完成'
  const escapedDetail = detail
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
  const badgeTitle = ok ? '✓ 授权成功，已连接 DeepSeek Harness' : '授权未完成，请重新发起'
  const subText = ok
    ? '已将访问凭据安全保存，您可以关闭此页面并返回 DeepSeek Harness 继续对话。'
    : '请关闭此页面，回到 DeepSeek Harness 设置中重新点击「打开网页登录授权」。'
  const noticeClass = ok ? 'feedback' : 'error'
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${title}</title>
  <style>
    :root {
      --ink: #141414;
      --paper: #ffffff;
      --muted: #8a8a8a;
      --line: #e4e4e4;
      --seal: #b4342a;
      --ok: #1f7a4c;
      --field: #fafafa;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #f2f2f2;
        --paper: #141414;
        --muted: #8a8a8a;
        --line: #2c2c2c;
        --field: #1c1c1c;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--paper);
      color: var(--ink);
      padding: 24px;
      font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    .card { width: 100%; max-width: 360px; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; }
    .seal { width: 44px; height: 44px; flex: none; display: block; }
    .brand-text strong { display: block; font-size: 17px; font-weight: 600; letter-spacing: .5px; }
    .brand-text span { color: var(--muted); font-size: 12px; letter-spacing: 2px; }
    .badge {
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--field);
      margin-bottom: 20px;
      font-size: 14px;
    }
    .badge strong { display: block; font-size: 15px; margin-top: 4px; color: var(--ink); }
    .feedback {
      margin-bottom: 14px;
      padding: 12px 14px;
      border-radius: 6px;
      background: rgba(31, 122, 76, .12);
      color: var(--ok);
      font-size: 14px;
      font-weight: 500;
    }
    .error {
      margin-bottom: 14px;
      padding: 12px 14px;
      border-radius: 6px;
      background: rgba(180, 52, 42, .1);
      color: var(--seal);
      font-size: 14px;
      font-weight: 500;
    }
    .sub { font-size: 13px; color: var(--muted); margin-bottom: 12px; }
    button {
      width: 100%;
      height: 46px;
      margin-top: 8px;
      border: 0;
      border-radius: 6px;
      background: var(--ink);
      color: var(--paper);
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <svg class="seal" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true">
        <defs>
          <clipPath id="pw-plateClip">
            <rect x="48" y="48" width="416" height="416" rx="10" />
          </clipPath>
          <path id="pw-corner-cloud" fill="#f2ece0" fill-rule="evenodd" d="M 0 0 H 124 C 124 22 108 38 86 38 C 96 52 92 70 76 80 C 60 90 40 84 32 68 C 38 92 22 116 0 124 Z M 44 26 A 14 14 0 1 0 44 54 A 14 14 0 1 0 44 26 Z" />
        </defs>
        <g clip-path="url(#pw-plateClip)">
          <rect x="48" y="48" width="416" height="416" rx="10" fill="#9c3a2b" />
          <use href="#pw-corner-cloud" transform="translate(48 48)" />
          <use href="#pw-corner-cloud" transform="translate(464 48) scale(-1 1)" />
          <use href="#pw-corner-cloud" transform="translate(464 464) scale(-1 -1)" />
          <use href="#pw-corner-cloud" transform="translate(48 464) scale(1 -1)" />
          <g transform="translate(256 252) scale(0.84) translate(-256 -270)" fill="none" stroke="#f2ece0" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
            <path d="M148 140H364" />
            <path d="M176 200H336" />
            <path d="M196 258c-18 106 44 176 120 138 46-23 44-82 2-100-30-13-58 6-54 36 3 21 24 29 38 16" />
          </g>
        </g>
      </svg>
      <div class="brand-text">
        <strong>瞰维智管 · 开放授权</strong>
        <span>DEEPSEEK HARNESS CONNECTOR</span>
      </div>
    </div>

    <div class="${noticeClass}">${badgeTitle}</div>
    <div class="badge">
      ${ok ? '连接状态' : '原因说明'}
      <strong>${escapedDetail}</strong>
    </div>
    <div class="sub">${subText}</div>
    <button type="button" id="close-btn">关闭此页面</button>
  </main>
  <script nonce="${nonce}">
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        try { window.close(); } catch {}
      });
    }
    ${ok ? 'setTimeout(() => { try { window.close(); } catch {} }, 1200);' : ''}
  </script>
</body>
</html>`
  return { html, nonce }
}
