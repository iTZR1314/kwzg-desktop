/**
 * Real-composition tests for `@deepseek-ai/dsh-parkwise-connector`:
 * OAuth 2.0 + PKCE (`S256`) browser flow over `ctx.webServer`, credential storage in
 * `ctx.credentials`, Streamable HTTP MCP connection in `ctx.mcpManager`, bundled
 * `parkwise-skill` exposure in `ctx.skills`, and SystemPrompt guidance updates.
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { PARKWISE_SKILL_NAME, ParkwiseConnector } from '../src/index.ts'
import {
  fetchParkwiseSessionProfile,
  parseCompanyNameFromTablePayload,
  parseSessionInfoPayload,
} from '../src/profile.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()
  private readonly records = new Map<string, CredentialRecord>()

  get writable(): boolean {
    return true
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(String(ref))
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      configured: this.values.has(String(ref)),
      writable: true,
    } as CredentialInfo)
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(String(ref), value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(String(ref))
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(String(key)))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({
      configured: this.records.has(String(key)),
      writable: true,
    } as CredentialRecordInfo)
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries: CredentialRecordEntry[] = []
    for (const [key, record] of this.records) {
      entries.push({ key: key as CredentialKey, kind: record.kind })
    }
    return Promise.resolve(entries)
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const k = String(key)
    const next = await mutate(this.records.get(k))
    if (next === undefined) {
      this.records.delete(k)
    } else {
      this.records.set(k, next)
    }
    this.notifyRecordUpdated(key)
    return next
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(String(key))
    this.notifyRecordUpdated(key)
    return Promise.resolve()
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

const SAMPLE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig'
const ISSUED_ACCESS_TOKEN = `acme-corp.${SAMPLE_JWT}`
const ISSUED_REFRESH_TOKEN = 'refresh-token-1'

interface MockGateway {
  readonly origin: string
  readonly seenChallenges: string[]
  readonly seenClientNames: Array<string | null>
  readonly seenToolCalls: Array<{ name: string; authorization: string | undefined }>
  close: () => Promise<void>
}

async function startMockGateway(): Promise<MockGateway> {
  const seenChallenges: string[] = []
  const seenClientNames: Array<string | null> = []
  const seenToolCalls: Array<{ name: string; authorization: string | undefined }> = []
  let issuedCodeChallenge = ''
  let issuedRedirectUri = ''
  let origin = ''

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/gw/oauth/authorize`,
        token_endpoint: `${origin}/gw/oauth/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/gw/oauth/token') {
      const raw = await readRequestBody(req)
      const params = new URLSearchParams(raw)
      if (params.get('grant_type') === 'authorization_code') {
        const verifier = params.get('code_verifier') ?? ''
        const expected = createHash('sha256').update(verifier).digest('base64url')
        if (expected !== issuedCodeChallenge || params.get('redirect_uri') !== issuedRedirectUri) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          access_token: ISSUED_ACCESS_TOKEN,
          refresh_token: ISSUED_REFRESH_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:read mcp:write',
        }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/gw/mcp') {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${ISSUED_ACCESS_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const raw = await readRequestBody(req)
      const rpc = JSON.parse(raw) as { id?: number | string; method: string; params?: Record<string, unknown> }
      if (rpc.method === 'notifications/initialized' || rpc.id === undefined) {
        res.writeHead(202).end()
        return
      }
      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'parkwise-mock', version: '1.0.0' },
          },
        }))
        return
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              {
                name: 'proc_query_boss_overview',
                description: 'Query executive overview',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        }))
        return
      }
      if (rpc.method === 'tools/call') {
        const rawName = rpc.params?.name
        const name = typeof rawName === 'string' ? rawName : ''
        seenToolCalls.push({ name, authorization: auth })
        const payload = name === 'get_my_session_info'
          ? {
            current_business_user: [{
              customer_id: 'acme-corp',
              real_name: '彭永杰',
              username: 'pyj',
              position: '招商总监',
            }],
            roles: [{ name: '园区管理员' }],
          }
          : name === 'query_table'
            ? {
              rows: [{ customer_id: 'acme-corp', name: '十一兄弟实业有限公司' }],
            }
            : { park_count: 3 }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          },
        }))
        return
      }
    }

    res.writeHead(404).end('not found')
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected gateway address')
  origin = `http://127.0.0.1:${String(address.port)}`

  return {
    origin,
    seenChallenges,
    seenClientNames,
    seenToolCalls,
    setChallenge(challenge: string, clientName: string | null, redirectUri: string) {
      issuedCodeChallenge = challenge
      issuedRedirectUri = redirectUri
      seenChallenges.push(challenge)
      seenClientNames.push(clientName)
    },
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  } as MockGateway & { setChallenge: (challenge: string, clientName: string | null, redirectUri: string) => void }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

describe('ParkwiseConnector real composition', () => {
  it('registers parkwise-skill, handles OAuth PKCE browser login, connects Streamable HTTP MCP, and signs out', async () => {
    const gateway = await startMockGateway() as MockGateway & {
      setChallenge: (challenge: string, clientName: string | null, redirectUri: string) => void
    }
    cleanups.push(() => gateway.close())

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())

    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.setExecutor({
      describe: () => ({ schemas: [] }),
      execute: async () => ({ outcomes: [], contextMessages: [] }),
    } as never)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(McpServerManager, {})
    await ctx.plugin(ParkwiseConnector, {
      mcpUrl: `${gateway.origin}/gw/mcp`,
      oauthOrigin: gateway.origin,
      allowLoopbackHttp: true,
    })

    // 1. Initial signed-out state: MCP waits silently on missing credential, skill is bundled, guidance guides sign-in.
    await vi.waitFor(async () => {
      const initial = await ctx.parkwise.getState()
      expect(initial.authStatus).toBe('signed-out')
      expect(initial.serverName).toBe('parkwise')
      expect(initial.mcpState).toBe('waiting-credentials')
    })

    const skills = await ctx.skills.list()
    expect(skills.some(skill => skill.name === PARKWISE_SKILL_NAME)).toBe(true)
    const loadedSkill = await ctx.skills.get(PARKWISE_SKILL_NAME)
    expect(loadedSkill?.content).toContain('mcp__parkwise__*')

    const signedOutPrompt = await ctx.systemPrompt.assemble()
    expect(signedOutPrompt.sections.some(section => section.name === 'parkwise:mcp-guidance')).toBe(true)
    const signedOutSection = signedOutPrompt.sections.find(section => section.name === 'parkwise:mcp-guidance')!
    expect(signedOutSection.text).toContain('打开网页登录授权')

    // 2. Start OAuth browser login against the live WebServer callback route.
    const callbackOrigin = ctx.webServer.getOrigin()
    await ctx.parkwise.startSignIn(callbackOrigin)

    let authorizeUrl = ''
    await vi.waitFor(async () => {
      const state = await ctx.parkwise.getState()
      expect(state.attempt?.phase).toBe('waiting-browser')
      authorizeUrl = state.attempt?.authorizeUrl ?? ''
    })

    const parsedAuth = new URL(authorizeUrl)
    expect(parsedAuth.pathname).toBe('/gw/oauth/authorize')
    expect(parsedAuth.searchParams.get('client_id')).toBe('deepseek-harness')
    expect(parsedAuth.searchParams.get('client_name')).toBe('DeepSeek Harness')
    expect(parsedAuth.searchParams.get('code_challenge_method')).toBe('S256')
    const challenge = parsedAuth.searchParams.get('code_challenge') ?? ''
    const stateParam = parsedAuth.searchParams.get('state') ?? ''
    const redirectUri = parsedAuth.searchParams.get('redirect_uri') ?? ''
    expect(redirectUri).toBe(`${callbackOrigin}/oauth/parkwise/callback`)

    gateway.setChallenge(challenge, parsedAuth.searchParams.get('client_name'), redirectUri)

    // 3. Browser completes consent and Gateway redirects to DeepSeek Harness loopback callback.
    const callbackUrl = new URL(redirectUri)
    callbackUrl.searchParams.set('code', 'auth-code-123')
    callbackUrl.searchParams.set('state', stateParam)
    const callbackRes = await fetch(callbackUrl)
    const callbackHtml = await callbackRes.text()
    expect(callbackRes.status).toBe(200)
    expect(callbackHtml).toContain('acme-corp')
    expect(callbackHtml).toContain('瞰维智管 · 开放授权')
    expect(callbackHtml).toContain('DEEPSEEK HARNESS CONNECTOR')
    expect(callbackHtml).toContain('#9c3a2b')
    expect(callbackHtml).toContain('prefers-color-scheme: dark')

    // 4. Token exchange commits credential, fetches member profile, McpServerManager connects, and MCP tool becomes callable.
    await vi.waitFor(async () => {
      const status = await ctx.parkwise.getState()
      expect(status.authStatus).toBe('credential-stored')
      expect(status.tenantSlug).toBe('acme-corp')
      expect(status.companyName).toBe('十一兄弟实业有限公司')
      expect(status.userName).toBe('彭永杰')
      expect(status.userPosition).toBe('招商总监')
      expect(status.roleNames).toEqual(['园区管理员'])
      expect(status.mcpState).toBe('connected')
      expect(status.toolCount).toBe(1)
    }, { timeout: 10_000 })

    expect(gateway.seenChallenges).toEqual([challenge])
    const tool = ctx.tools.get('mcp__parkwise__proc_query_boss_overview')
    expect(tool).toBeDefined()
    const toolOutput = await tool!.execute({}, {
      id: 'call-1',
      signal: new AbortController().signal,
      deferContext: () => {},
    } as never)
    expect(JSON.stringify(toolOutput)).toContain('park_count')
    expect(gateway.seenToolCalls).toEqual([
      { name: 'get_my_session_info', authorization: `Bearer ${ISSUED_ACCESS_TOKEN}` },
      { name: 'query_table', authorization: `Bearer ${ISSUED_ACCESS_TOKEN}` },
      { name: 'proc_query_boss_overview', authorization: `Bearer ${ISSUED_ACCESS_TOKEN}` },
    ])

    const connectedPrompt = await ctx.systemPrompt.assemble()
    const connectedSection = connectedPrompt.sections.find(section => section.name === 'parkwise:mcp-guidance')!
    expect(connectedSection.text).toContain('mcp__parkwise__proc_query_boss_overview')

    // 5. Sign out removes credentials, profile fields, and withdraws tools cleanly.
    const afterSignOut = await ctx.parkwise.signOut()
    expect(afterSignOut.authStatus).toBe('signed-out')
    expect(afterSignOut.companyName).toBeUndefined()
    expect(afterSignOut.userName).toBeUndefined()
    expect(afterSignOut.userPosition).toBeUndefined()
    await vi.waitFor(async () => {
      const state = await ctx.parkwise.getState()
      expect(state.mcpState).toBe('waiting-credentials')
      expect(ctx.tools.get('mcp__parkwise__proc_query_boss_overview')).toBeUndefined()
    })
  }, 20_000)

  it('rejects SpacetimeDB public placeholder "公共空间" and reads real tenant_name from /gw/oauth/userinfo or cached grants cleanly', async () => {
    expect(parseSessionInfoPayload({
      customer_name: '公共空间',
      current_business_user: [{ real_name: '彭永杰', position: '招商总监' }],
    })).toEqual({
      userName: '彭永杰',
      userPosition: '招商总监',
    })

    expect(parseCompanyNameFromTablePayload({
      rows: [{ customer_id: 'public', name: '公共空间' }],
    }, 'public')).toBeUndefined()

    const userinfoServer = createServer((req, res) => {
      if (req.url === '/gw/oauth/userinfo' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          tenant_slug: 'syxd',
          tenant_name: '十一兄弟',
        }))
        return
      }
      if (req.url === '/gw/mcp' && req.method === 'POST') {
        void readRequestBody(req).then((raw) => {
          const rpc = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string } }
          if (rpc.method === 'notifications/initialized' || rpc.id === undefined) {
            res.writeHead(202).end()
            return
          }
          if (rpc.method === 'initialize') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
            }))
            return
          }
          const payload = rpc.params?.name === 'get_my_session_info'
            ? { current_business_user: [{ customer_id: 'public', real_name: '彭永杰' }] }
            : { rows: [{ customer_id: 'public', name: '公共空间' }] }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
          }))
        })
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => { userinfoServer.listen(0, '127.0.0.1', () => { resolve() }) })
    try {
      const addr = userinfoServer.address()
      if (addr === null || typeof addr === 'string') throw new Error('unexpected address')
      const origin = `http://127.0.0.1:${String(addr.port)}`
      const profile = await fetchParkwiseSessionProfile({
        mcpUrl: `${origin}/gw/mcp`,
        oauthOrigin: origin,
        accessToken: 'tok-test',
        signal: AbortSignal.timeout(5_000),
      })
      expect(profile).toEqual({
        companyName: '十一兄弟',
        userName: '彭永杰',
      })
    } finally {
      await new Promise<void>((resolve) => { userinfoServer.close(() => { resolve() }) })
    }

    const gateway = await startMockGateway()
    cleanups.push(() => gateway.close())

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())

    await ctx.plugin(MemoryCredentials)
    const grantKey = credentialKey('parkwise-mcp', 'default')
    await ctx.credentials.modifyRecord(grantKey, () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        issuer: gateway.origin,
        accessToken: ISSUED_ACCESS_TOKEN,
        tenantSlug: 'syxd',
        companyName: '公共空间',
        userName: '彭永杰',
      },
    }))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.setExecutor({
      describe: () => ({ schemas: [] }),
      execute: async () => ({ outcomes: [], contextMessages: [] }),
    } as never)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(McpServerManager, {})
    await ctx.plugin(ParkwiseConnector, {
      mcpUrl: `${gateway.origin}/gw/mcp`,
      oauthOrigin: gateway.origin,
      allowLoopbackHttp: true,
    })

    const state = await ctx.parkwise.getState()
    expect(state.companyName).toBeUndefined()
    expect(state.tenantSlug).toBe('syxd')
    expect(state.userName).toBe('彭永杰')
  })
})
