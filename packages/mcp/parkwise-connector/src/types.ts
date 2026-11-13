/** Client-safe ParkWise MCP connection state, attempt progress, and error codes; credentials never cross this boundary. */

import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one local ParkWise OAuth login attempt. */
export type ParkwiseAttemptId = Branded<'ParkwiseAttemptId'>

/**
 * Safe failure codes rendered through the Client's locale dictionary.
 * `no-response`: HTTP request rejected or timed out; `network`: non-OK HTTP response;
 * `protocol`: malformed metadata/token response or invalid callback; `expired`: authorization expired;
 * `storage`: local credential read/write failed; `access-denied`: user rejected OAuth consent.
 */
export type ParkwiseErrorCode =
  | 'no-response'
  | 'network'
  | 'protocol'
  | 'expired'
  | 'storage'
  | 'access-denied'

/** Progress of the latest ParkWise browser OAuth attempt. */
export interface ParkwiseAttemptView {
  readonly id: ParkwiseAttemptId
  readonly phase:
    | 'initializing'
    | 'waiting-browser'
    | 'exchanging'
    | 'committing'
    | 'succeeded'
    | 'cancelled'
    | 'expired'
    | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: ParkwiseErrorCode
}

/** High-level MCP server connection phase derived from `mcp-manager`. */
export type ParkwiseMcpState =
  | 'waiting-credentials'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disabled'

/** Safe snapshot combining OAuth credential state and live MCP server status. */
export interface ParkwiseStatusView {
  readonly authStatus: 'signed-out' | 'credential-stored'
  readonly serverName: string
  readonly mcpUrl: string
  readonly oauthOrigin: string
  readonly tenantSlug?: string
  readonly companyName?: string
  readonly userName?: string
  readonly userPosition?: string
  readonly roleNames?: readonly string[]
  readonly scope?: string
  readonly expiresAt?: number
  readonly mcpState: ParkwiseMcpState
  readonly toolCount?: number
  readonly mcpError?: string
  readonly attempt: ParkwiseAttemptView | null
}

/** Ordered update frame emitted by `remote.parkwise.watch`. */
export interface ParkwiseUpdate {
  readonly type: 'snapshot' | 'credentials-changed' | 'mcp-changed'
  readonly state: ParkwiseStatusView
}
