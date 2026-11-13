/** Localized copy dictionaries for the ParkWise MCP authorization and status page. */

/** Locale keys rendered by the ParkWise settings & plugins views. */
export type ParkwiseSettingsLocaleKey =
  | 'nav'
  | 'brandTitle'
  | 'title'
  | 'description'
  | 'authCardTitle'
  | 'signedOutHint'
  | 'signedInHint'
  | 'tenantLabel'
  | 'accountLabel'
  | 'endpointLabel'
  | 'mcpStatusLabel'
  | 'skillLabel'
  | 'skillActive'
  | 'signInButton'
  | 'reauthorizeButton'
  | 'openAuthorizePage'
  | 'copyAuthorizeUrl'
  | 'copied'
  | 'cancel'
  | 'reconnect'
  | 'signOut'
  | 'waitingInitializing'
  | 'waitingBrowser'
  | 'waitingExchanging'
  | 'waitingCommitting'
  | 'stateConnected'
  | 'stateConnecting'
  | 'stateReconnecting'
  | 'stateWaitingCredentials'
  | 'stateFailed'
  | 'stateDisabled'
  | 'stateLoading'
  | 'streamError'
  | 'attemptExpired'
  | 'attemptDenied'
  | 'attemptFailed'
  | 'oauthGuide'

/** English copy. */
export const en: Record<ParkwiseSettingsLocaleKey, string> = {
  nav: 'ParkWise MCP',
  brandTitle: 'DSH × ParkWise',
  title: 'ParkWise (瞰维智管)',
  description: 'Connect ParkWise Smart Park to query and handle park operations directly in chat.',
  authCardTitle: 'ParkWise OAuth Authorization',
  signedOutHint: 'Sign in with your ParkWise gateway web account (Company + Account + Password) to enable parkwise MCP tools.',
  signedInHint: 'Authorized via browser OAuth; ParkWise MCP tools (`mcp__parkwise__*`) and built-in skill guidance are active.',
  tenantLabel: 'Enterprise',
  accountLabel: 'Member',
  endpointLabel: 'MCP Endpoint',
  mcpStatusLabel: 'Connection Status',
  skillLabel: 'Built-in Skill & Guidance',
  skillActive: 'parkwise-skill enabled',
  signInButton: 'Sign in via Browser',
  reauthorizeButton: 'Re-authorize in Browser',
  openAuthorizePage: 'Open Authorization Page',
  copyAuthorizeUrl: 'Copy Link',
  copied: 'Copied',
  cancel: 'Cancel',
  reconnect: 'Reconnect MCP',
  signOut: 'Sign Out',
  waitingInitializing: 'Preparing OAuth PKCE authorization…',
  waitingBrowser: 'Complete login and consent in the opened browser page…',
  waitingExchanging: 'Exchanging authorization code for MCP token…',
  waitingCommitting: 'Saving credentials and connecting MCP…',
  stateConnected: 'Connected ({count} tools)',
  stateConnecting: 'Connecting to ParkWise MCP…',
  stateReconnecting: 'Reconnecting to ParkWise MCP…',
  stateWaitingCredentials: 'Not authorized yet',
  stateFailed: 'Connection failed: {error}',
  stateDisabled: 'Disabled',
  stateLoading: 'Loading ParkWise connector status…',
  streamError: 'Unable to reach ParkWise connector on the Host.',
  attemptExpired: 'Authorization timed out. Please try again.',
  attemptDenied: 'Authorization was declined in the browser.',
  attemptFailed: 'Authorization failed ({code}). Please try again.',
  oauthGuide: 'Supports existing ParkWise Web sessions (one-click consent) or Company + Account + Password login.',
}

/** Simplified Chinese copy. */
export const zh: Record<ParkwiseSettingsLocaleKey, string> = {
  nav: '瞰维智管',
  brandTitle: 'DSH × 瞰维智管',
  title: '瞰维智管 (ParkWise)',
  description: '连接瞰维智管智慧园区服务，授权后即可在对话中直接查询与办理园区业务。',
  authCardTitle: 'ParkWise 网页 OAuth 授权',
  signedOutHint: '点击下方按钮在浏览器打开瞰维智管网关登录页，输入「公司名称 + 账号 + 密码」完成授权后即可自动启用全部智慧园区 MCP 工具。',
  signedInHint: '已完成网页 OAuth 授权，ParkWise MCP 工具（mcp__parkwise__*）与内置 parkwise-skill 已就绪。',
  tenantLabel: '当前企业',
  accountLabel: '当前成员',
  endpointLabel: 'MCP 地址',
  mcpStatusLabel: '连接状态',
  skillLabel: '内置技能与指引',
  skillActive: '已内置启用 parkwise-skill',
  signInButton: '打开网页登录授权',
  reauthorizeButton: '重新打开网页授权',
  openAuthorizePage: '打开授权网页',
  copyAuthorizeUrl: '复制授权链接',
  copied: '已复制',
  cancel: '取消授权',
  reconnect: '重新连接',
  signOut: '退出授权',
  waitingInitializing: '正在生成 PKCE 参数并准备授权页面…',
  waitingBrowser: '请在打开的浏览器网页中登录并确认授权…',
  waitingExchanging: '正在换取 MCP 访问凭据…',
  waitingCommitting: '正在保存凭据并连接 ParkWise MCP…',
  stateConnected: '已连接（可用 {count} 个工具）',
  stateConnecting: '正在连接 ParkWise MCP…',
  stateReconnecting: '正在重连 ParkWise MCP…',
  stateWaitingCredentials: '待网页登录授权',
  stateFailed: '连接失败：{error}',
  stateDisabled: '未启用',
  stateLoading: '正在读取 ParkWise 连接状态…',
  streamError: '无法读取 Host 端的 ParkWise 连接器状态。',
  attemptExpired: '本次网页授权已超时，请重新点击授权。',
  attemptDenied: '您在网页中拒绝了本次授权。',
  attemptFailed: '网页授权失败（{code}），请重试。',
  oauthGuide: '已登录智慧园区网页版可直接一键确认授权；未登录可直接输入公司名 + 账号 + 密码登录。',
}

/** Japanese copy. */
export const ja = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
/** Spanish copy. */
export const es = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
/** French copy. */
export const fr = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
/** German copy. */
export const de = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
/** Russian copy. */
export const ru = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
/** Portuguese copy. */
export const pt = { ...en } satisfies Record<ParkwiseSettingsLocaleKey, string>
