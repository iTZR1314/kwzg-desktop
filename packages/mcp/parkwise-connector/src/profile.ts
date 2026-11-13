/** Streamable HTTP `get_my_session_info`, `/gw/oauth/userinfo`, and tenant lookup helper for safe ParkWise identity metadata. */

import { sanitizedCompanyName } from './oauth.ts'

/** Safe ParkWise user identity, position, and company metadata derived from MCP session views. */
export interface ParkwiseUserProfile {
  readonly companyName?: string
  readonly userName?: string
  readonly userPosition?: string
  readonly roleNames?: readonly string[]
}

const MCP_PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcMessage {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

async function readJsonRpcResponse(response: Response, expectedId?: number): Promise<JsonRpcMessage | undefined> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const raw = await response.text()
  if (raw.trim().length === 0) return undefined

  if (contentType.includes('text/event-stream') || raw.includes('data:')) {
    const messages: JsonRpcMessage[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const parsed: unknown = JSON.parse(payload)
        if (isRecord(parsed)) messages.push(parsed)
      } catch {
        // Ignore partial or keepalive SSE frames.
      }
    }
    if (expectedId !== undefined) {
      const matched = messages.find(message => message.id === expectedId)
      if (matched !== undefined) return matched
    }
    return messages.at(-1)
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const records = parsed.filter(isRecord)
      if (expectedId !== undefined) {
        const matched = records.find(message => message.id === expectedId)
        if (matched !== undefined) return matched
      }
      return records.at(-1)
    }
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

interface ParsedSessionDetails {
  readonly profile?: ParkwiseUserProfile
  readonly customerId?: string
}

function parseSessionInfoDetails(payload: unknown): ParsedSessionDetails {
  if (!isRecord(payload)) return {}

  const businessUsers = Array.isArray(payload.current_business_user) ? payload.current_business_user : []
  const centerUsers = Array.isArray(payload.current_center_user) ? payload.current_center_user : []
  const roles = Array.isArray(payload.roles) ? payload.roles : []
  const parks = Array.isArray(payload.authorized_parks) ? payload.authorized_parks : []

  const businessUser = isRecord(businessUsers[0]) ? businessUsers[0] : undefined
  const centerUser = isRecord(centerUsers[0]) ? centerUsers[0] : undefined
  const firstPark = isRecord(parks[0]) ? parks[0] : undefined

  const roleNames: string[] = []
  for (const role of roles) {
    if (!isRecord(role)) continue
    const name = nonEmptyTrimmed(role.name)
    if (name !== undefined && !roleNames.includes(name)) roleNames.push(name)
  }

  const position = nonEmptyTrimmed(businessUser?.position)
  const userPosition = position ?? (roleNames.length > 0 ? roleNames.join(' · ') : undefined)

  const userName = nonEmptyTrimmed(businessUser?.real_name)
    ?? nonEmptyTrimmed(centerUser?.real_name)
    ?? nonEmptyTrimmed(businessUser?.username)
    ?? nonEmptyTrimmed(centerUser?.username)

  const companyName = sanitizedCompanyName(payload.tenant_name)
    ?? sanitizedCompanyName(payload.company_name)
    ?? sanitizedCompanyName(payload.customer_name)
    ?? sanitizedCompanyName(businessUser?.company_name)
    ?? sanitizedCompanyName(businessUser?.customer_name)

  const customerId = nonEmptyTrimmed(businessUser?.customer_id)
    ?? nonEmptyTrimmed(firstPark?.customer_id)

  if (
    companyName === undefined
    && userName === undefined
    && userPosition === undefined
    && roleNames.length === 0
  ) {
    return customerId === undefined ? {} : { customerId }
  }

  return {
    ...customerId === undefined ? {} : { customerId },
    profile: {
      ...companyName === undefined ? {} : { companyName },
      ...userName === undefined ? {} : { userName },
      ...userPosition === undefined ? {} : { userPosition },
      ...roleNames.length === 0 ? {} : { roleNames },
    },
  }
}

/**
 * Parse raw `get_my_session_info` JSON into safe display fields (`companyName`, `userName`, `userPosition`, `roleNames`).
 * @param payload - decoded JSON object returned by ParkWise `get_my_session_info`.
 * @returns non-empty profile fields, or `undefined` if nothing usable is present.
 */
export function parseSessionInfoPayload(payload: unknown): ParkwiseUserProfile | undefined {
  return parseSessionInfoDetails(payload).profile
}

/**
 * Extract the display company name from a `query_table` response on `my_tenants` or `dashboard_overview`.
 * @param payload - decoded JSON object returned by ParkWise `query_table`.
 * @param customerId - active `customer_id` from `current_business_user` when available.
 * @returns non-empty company display name or `undefined`.
 */
export function parseCompanyNameFromTablePayload(payload: unknown, customerId?: string): string | undefined {
  if (!isRecord(payload)) return undefined
  const rows = Array.isArray(payload.rows) ? payload.rows.filter(isRecord) : []
  if (rows.length === 0) return undefined

  const matched = customerId === undefined
    ? rows[0]
    : (rows.find(row => nonEmptyTrimmed(row.customer_id) === customerId) ?? rows[0])
  if (matched === undefined) return undefined

  return sanitizedCompanyName(matched.tenant_name)
    ?? sanitizedCompanyName(matched.customer_name)
    ?? sanitizedCompanyName(matched.name)
    ?? sanitizedCompanyName(matched.company_short_name)
}

function extractToolPayload(result: unknown): unknown {
  if (!isRecord(result) || result.isError === true) return undefined
  if (isRecord(result.structuredContent)) return result.structuredContent

  const content = Array.isArray(result.content) ? result.content : []
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue
    try {
      return JSON.parse(item.text)
    } catch {
      continue
    }
  }
  return undefined
}

interface McpToolCallResult {
  readonly payload: unknown
  readonly headerTenantName?: string
}

function decodeHeaderTenantName(response: Response): string | undefined {
  const raw = response.headers.get('x-parkwise-tenant-name')
  if (raw === null) return undefined
  try {
    return sanitizedCompanyName(decodeURIComponent(raw))
  } catch {
    return sanitizedCompanyName(raw)
  }
}

async function fetchOAuthUserInfoCompanyName(
  oauthOrigin: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const url = new URL('/gw/oauth/userinfo', oauthOrigin)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      signal,
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (!isRecord(body)) return undefined
    return sanitizedCompanyName(body.tenant_name)
      ?? sanitizedCompanyName(body.company_name)
      ?? sanitizedCompanyName(body.display_name)
  } catch {
    return undefined
  }
}

async function callMcpToolJson(options: {
  readonly mcpUrl: string
  readonly headers: Record<string, string>
  readonly id: number
  readonly name: string
  readonly args: Record<string, unknown>
  readonly signal: AbortSignal
}): Promise<McpToolCallResult | undefined> {
  const response = await fetch(options.mcpUrl, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id,
      method: 'tools/call',
      params: {
        name: options.name,
        arguments: options.args,
      },
    }),
    signal: options.signal,
  })
  if (!response.ok) return undefined
  const headerTenantName = decodeHeaderTenantName(response)
  const message = await readJsonRpcResponse(response, options.id)
  if (message === undefined || message.error !== undefined) {
    return headerTenantName === undefined ? undefined : { payload: undefined, headerTenantName }
  }
  return {
    payload: extractToolPayload(message.result),
    ...headerTenantName === undefined ? {} : { headerTenantName },
  }
}

/**
 * Query `get_my_session_info`, gateway `/gw/oauth/userinfo`, and tenant tables
 * once against the ParkWise endpoints.
 * Never throws; any network, auth, or schema mismatch resolves to `undefined`.
 * @param options - MCP endpoint URL, optional OAuth origin, bearer access token, and cancellation signal.
 * @returns resolved {@link ParkwiseUserProfile} or `undefined`.
 */
export async function fetchParkwiseSessionProfile(options: {
  readonly mcpUrl: string
  readonly oauthOrigin?: string
  readonly accessToken: string
  readonly signal: AbortSignal
}): Promise<ParkwiseUserProfile | undefined> {
  const { mcpUrl, oauthOrigin, accessToken, signal } = options
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': `Bearer ${accessToken}`,
  }
  let sessionId: string | undefined

  try {
    const initRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'deepseek-harness-profile', version: '1.0.0' },
        },
      }),
      signal,
    })
    if (!initRes.ok) return undefined
    sessionId = initRes.headers.get('mcp-session-id')?.trim() || undefined
    await readJsonRpcResponse(initRes, 1)

    const sessionHeaders: Record<string, string> = sessionId === undefined
      ? baseHeaders
      : { ...baseHeaders, 'mcp-session-id': sessionId }

    const notifyRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      signal,
    })
    await notifyRes.text().catch(() => '')

    const sessionResult = await callMcpToolJson({
      mcpUrl,
      headers: sessionHeaders,
      id: 2,
      name: 'get_my_session_info',
      args: {},
      signal,
    })
    const { profile, customerId } = parseSessionInfoDetails(sessionResult?.payload)

    let companyName = profile?.companyName ?? sessionResult?.headerTenantName
    if (companyName === undefined && oauthOrigin !== undefined) {
      companyName = await fetchOAuthUserInfoCompanyName(oauthOrigin, accessToken, signal)
    }
    if (companyName === undefined) {
      const tenantsResult = await callMcpToolJson({
        mcpUrl,
        headers: sessionHeaders,
        id: 3,
        name: 'query_table',
        args: { table: 'my_tenants', limit: 20 },
        signal,
      }).catch(() => undefined)
      companyName = tenantsResult?.headerTenantName
        ?? parseCompanyNameFromTablePayload(tenantsResult?.payload, customerId)

      if (companyName === undefined) {
        const overviewResult = await callMcpToolJson({
          mcpUrl,
          headers: sessionHeaders,
          id: 4,
          name: 'query_table',
          args: { table: 'dashboard_overview', limit: 1 },
          signal,
        }).catch(() => undefined)
        companyName = overviewResult?.headerTenantName
          ?? parseCompanyNameFromTablePayload(overviewResult?.payload, customerId)
      }
    }

    if (profile === undefined && companyName === undefined) return undefined
    return {
      ...profile,
      ...companyName === undefined ? {} : { companyName },
    }
  } catch {
    return undefined
  } finally {
    if (sessionId !== undefined) {
      await fetch(mcpUrl, {
        method: 'DELETE',
        headers: {
          'authorization': `Bearer ${accessToken}`,
          'mcp-session-id': sessionId,
        },
        signal: AbortSignal.timeout(1_000),
      }).catch(() => undefined)
    }
  }
}
