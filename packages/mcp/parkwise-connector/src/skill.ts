/** Bundled `parkwise-skill` provider and default MCP tool usage guidance for SystemPrompt. */

import { readFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { parse as parseYaml } from 'yaml'

/** Skill identifier exposed to `ctx.skills` and the `skill` tool. */
export const PARKWISE_SKILL_NAME = 'parkwise-skill'

/** Standard precedence rank matching `@deepseek-ai/dsh-skill`'s `BUNDLED_SKILL_RANK`. */
const BUNDLED_SKILL_RANK = 600

const SKILL_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skills', PARKWISE_SKILL_NAME)
const SKILL_PATH = join(SKILL_DIRECTORY, 'SKILL.md')

const MCP_GUIDANCE_SECTION_NAME = 'parkwise:mcp-guidance'

interface ParsedSkill {
  readonly description: string
  readonly content: string
}

function parseSkillMarkdown(raw: string, path: string): ParsedSkill {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) {
    throw new Error(`parkwise-connector: ${path} has no YAML frontmatter`)
  }
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`parkwise-connector: ${path} has no description`)
  }
  return {
    description: description.trim(),
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

async function readBundledSkill(signal?: AbortSignal): Promise<ParsedSkill | undefined> {
  try {
    const raw = await readFile(SKILL_PATH, {
      encoding: 'utf8',
      ...signal === undefined ? {} : { signal },
    })
    return parseSkillMarkdown(raw, SKILL_PATH)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return undefined
  }
}

/**
 * Build the default system prompt guidance section directing the model to use `parkwise-skill`
 * and the `mcp__parkwise__*` three-tier tool hierarchy, or guide the user to authorize when disconnected.
 * @param serverName - configured MCP server name (default `'parkwise'`).
 * @param isAuthorized - returns whether ParkWise MCP credentials are currently stored/connected.
 * @returns section text generator evaluated at each prompt assembly.
 */
export function parkwiseGuidanceText(serverName: string, isAuthorized: () => boolean): string {
  const prefix = `mcp__${serverName}__`
  if (isAuthorized()) {
    return [
      `## ParkWise MCP (${serverName})`,
      '',
      `Built-in ParkWise enterprise park management MCP tools are active under \`${prefix}*\`.`,
      `Before querying or modifying ParkWise business data (park occupancy, leasing/contracts, utility billing, finance, payroll, HR/attendance, or inspections), load \`${PARKWISE_SKILL_NAME}\` via the \`skill\` tool first so you strictly follow the three-tier hierarchy:`,
      `1. First-priority authoritative Procedures (\`${prefix}proc_*\`, e.g. \`${prefix}proc_query_boss_overview\`, \`${prefix}proc_query_park_occupancy\`, \`${prefix}proc_query_billing_page\`, \`${prefix}proc_query_finance_page\`).`,
      `2. Drill-down Views (\`${prefix}list_tables\`, \`${prefix}describe_table\`, \`${prefix}query_table\`) only when Procedures do not cover the specific detail.`,
      `3. Delegated write Reducers (\`${prefix}list_reducers\` -> \`${prefix}describe_reducer\` -> \`${prefix}invoke_reducer\`) and \`${prefix}api_*\` endpoints for business actions or exports.`,
      'Never treat null/0 optional fields or empty 0-row optional module tables as bugs, and honor fixed-point `*_cents` / `*_centi_square_metres` / `*_basis_points` conversions.',
    ].join('\n')
  }
  return [
    `## ParkWise MCP (${serverName})`,
    '',
    `The built-in ParkWise MCP integration (\`${serverName}\`) is available in this harness, and \`${PARKWISE_SKILL_NAME}\` provides its workflow guide, but the user has not completed browser OAuth authorization yet.`,
    `If the user asks to query or manage ParkWise (瞰维智管 / 智慧园区) data and \`${prefix}*\` tools are unavailable, ask them to open **Settings -> 瞰维智管 (ParkWise)** (or **Plugins -> Official -> 瞰维智管 (ParkWise)**) and click **打开网页登录授权** to sign in via browser OAuth.`,
  ].join('\n')
}

/**
 * Register bundled `parkwise-skill` on `ctx.skills` (when mounted) and default MCP guidance on
 * `ctx.systemPrompt` (when mounted). Registration cleans up automatically via the returned disposers.
 * @param ctx - plugin context owning effect lifetime.
 * @param options - skill/guidance enablement and live authorization reader.
 */
export function registerSkillAndGuidance(
  ctx: Context,
  options: {
    readonly serverName: string
    readonly enableSkill: boolean
    readonly enableGuidance: boolean
    readonly skillDirectory?: string
    readonly isAuthorized: () => boolean
  },
): void {
  const directory = options.skillDirectory ?? SKILL_DIRECTORY
  const filePath = join(directory, 'SKILL.md')

  if (options.enableSkill) {
    ctx.inject(['skills'], (inner) => {
      inner.skills.registerProvider(control => ({
        name: 'dsh-parkwise',
        async list(listOptions) {
          const parsed = options.skillDirectory === undefined
            ? await readBundledSkill(listOptions.signal)
            : await readFile(filePath, {
              encoding: 'utf8',
              ...listOptions.signal === undefined ? {} : { signal: listOptions.signal },
            })
              .then(raw => parseSkillMarkdown(raw, filePath))
              .catch((error: unknown) => {
                if (error instanceof Error && error.name === 'AbortError') throw error
                return undefined
              })
          if (parsed === undefined) return { candidates: [], complete: true }
          const candidate: SkillCandidate = {
            name: PARKWISE_SKILL_NAME,
            description: parsed.description,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'dsh-parkwise',
            source: 'bundled',
            rank: BUNDLED_SKILL_RANK,
            resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
            locator: filePath,
          }
          return { candidates: [candidate], complete: true }
        },
        async get(candidate, getOptions) {
          const { rank: _rank, locator: _locator, ...summary } = candidate
          try {
            const raw = await readFile(filePath, {
              encoding: 'utf8',
              ...getOptions.signal === undefined ? {} : { signal: getOptions.signal },
            })
            const parsed = parseSkillMarkdown(raw, filePath)
            return { ...summary, content: parsed.content }
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error
            control.invalidate()
            return undefined
          }
        },
      }))
    })
  }

  if (options.enableGuidance) {
    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.section({
        name: MCP_GUIDANCE_SECTION_NAME,
        order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') + 10,
        interpolate: false,
        text: () => parkwiseGuidanceText(options.serverName, options.isAuthorized),
      })
    })
  }
}
