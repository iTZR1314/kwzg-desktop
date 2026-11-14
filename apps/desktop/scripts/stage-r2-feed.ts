/** Stage (and optionally upload to Cloudflare R2) generic electron-updater feed metadata and artifacts. */

import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dump, load } from 'js-yaml'
import {
  desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateConfig,
} from './desktop-auto-update-environment.mjs'
import {
  desktopArtifactOutput,
  desktopTargetBuildPaths,
  desktopTargetPlatform,
} from './desktop-build-paths.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

export interface StagedFeedFile {
  readonly sourcePath?: string
  readonly contents?: string
  readonly key: string
  readonly contentType: string
  readonly cacheControl: string
  readonly isMetadata: boolean
}

export interface StagedR2Plan {
  readonly target: DesktopPackageTargetName
  readonly version: string
  readonly feedUrl: string
  readonly stageRoot: string
  readonly files: readonly StagedFeedFile[]
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function fileSha512Base64(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/**
 * Rewrite electron-builder channel metadata so files[0].url and path resolve to the self-hosted R2 binary prefix.
 * Files are ordered with binaries first and metadata YAML last so uploads never expose dangling YAML links.
 */
export async function buildR2StagePlan(
  target: DesktopPackageTargetName,
  options: {
    readonly unsigned?: boolean
    readonly env?: NodeJS.ProcessEnv
    readonly artifactsDir?: string
    readonly stageRoot?: string
  } = {},
): Promise<StagedR2Plan> {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`r2 feed: unsupported target ${String(target)}`)
  }
  const { platform, arch } = desktopTargetPlatform(target)
  const unsigned = options.unsigned ?? false
  const env = options.env ?? (() => {
    try {
      return loadDesktopPackageEnvironment(platform, process.env, APP_ROOT, { unsigned })
    } catch {
      return process.env
    }
  })()
  const update = resolveDesktopAutoUpdateConfig(env, platform, arch)
  const paths = desktopTargetBuildPaths(target, env)
  const artifactsDir = options.artifactsDir
    ?? desktopArtifactOutput(paths, { unsigned, skipNotarization: false }).directory
  const stageRoot = options.stageRoot ?? join(paths.root, 'r2-stage')

  const versionPlaceholder = '0.0.0'
  const metadataFilename = desktopUpdateMetadataFilename(versionPlaceholder, platform, update.channel)
  const metadataPath = join(artifactsDir, metadataFilename)
  const parsed = load(await readFile(metadataPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`r2 feed: ${metadataPath} must be a YAML object`)
  }
  const metadata = parsed as Record<string, unknown>
  const version = metadata.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`r2 feed: ${metadataPath} missing version`)
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`r2 feed: ${metadataPath} missing files list`)
  }
  const primary = metadata.files[0]
  if (typeof primary !== 'object' || primary === null || Array.isArray(primary)) {
    throw new Error(`r2 feed: ${metadataPath}.files[0] must be an object`)
  }
  const entry = primary as Record<string, unknown>
  const rawUrl = entry.url ?? metadata.path
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    throw new Error(`r2 feed: ${metadataPath}.files[0].url must be a non-empty filename`)
  }
  const binaryFilename = basename(rawUrl)
  const binaryPath = join(artifactsDir, binaryFilename)
  const binaryStats = await stat(binaryPath)
  if (typeof entry.size === 'number' && entry.size !== binaryStats.size) {
    throw new Error(`r2 feed: ${binaryFilename} size ${binaryStats.size} mismatches YAML ${entry.size}`)
  }
  if (typeof entry.sha512 === 'string') {
    const actualSha512 = await fileSha512Base64(binaryPath)
    if (actualSha512 !== entry.sha512) {
      throw new Error(`r2 feed: ${binaryFilename} sha512 mismatches YAML`)
    }
  }

  const blockmapFilename = `${binaryFilename}.blockmap`
  const blockmapPath = join(artifactsDir, blockmapFilename)
  const files: StagedFeedFile[] = []
  const binaryMime = platform === 'darwin'
    ? 'application/zip'
    : 'application/vnd.microsoft.portable-executable'

  files.push({
    sourcePath: binaryPath,
    key: `${update.binaryKeyPrefix}/${binaryFilename}`,
    contentType: binaryMime,
    cacheControl: 'public, max-age=31536000, immutable',
    isMetadata: false,
  })

  if (await stat(blockmapPath).then(s => s.isFile()).catch(() => false)) {
    files.push({
      sourcePath: blockmapPath,
      key: `${update.binaryKeyPrefix}/${blockmapFilename}`,
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
      isMetadata: false,
    })
  }

  if (platform === 'darwin') {
    const dmgFilename = binaryFilename.replace(/\.zip$/u, '.dmg')
    const dmgPath = join(artifactsDir, dmgFilename)
    if (await stat(dmgPath).then(s => s.isFile()).catch(() => false)) {
      files.push({
        sourcePath: dmgPath,
        key: `${update.binaryKeyPrefix}/${dmgFilename}`,
        contentType: 'application/x-apple-diskimage',
        cacheControl: 'public, max-age=31536000, immutable',
        isMetadata: false,
      })
    }
  }

  const absoluteBinaryUrl = `${update.origin}/${update.binaryKeyPrefix}/${binaryFilename}`
  const published = {
    ...metadata,
    files: [{ ...entry, url: absoluteBinaryUrl }, ...metadata.files.slice(1)],
    ...(metadata.path === undefined ? {} : { path: absoluteBinaryUrl }),
  }

  files.push({
    contents: dump(published, { lineWidth: -1, noRefs: true }),
    key: `${update.keyPrefix}/${metadataFilename}`,
    contentType: 'text/yaml; charset=utf-8',
    cacheControl: 'no-cache, max-age=60',
    isMetadata: true,
  })

  return {
    target,
    version,
    feedUrl: `${update.publicUrl}${metadataFilename}`,
    stageRoot,
    files,
  }
}

export async function writeR2StageFiles(plan: StagedR2Plan): Promise<void> {
  for (const item of plan.files) {
    const dest = join(plan.stageRoot, item.key)
    await mkdir(dirname(dest), { recursive: true })
    if (item.contents !== undefined) {
      await writeFile(dest, item.contents, 'utf8')
    } else if (item.sourcePath !== undefined) {
      await copyFile(item.sourcePath, dest)
    }
  }
}

async function uploadS3Object(params: {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly key: string
  readonly body: Buffer
  readonly contentType: string
  readonly cacheControl: string
}): Promise<void> {
  const endpointUrl = new URL(params.endpoint.replace(/\/+$/u, ''))
  const objectPath = `/${encodeURIComponent(params.bucket)}/${encodeS3Path(params.key)}`
  const targetUrl = new URL(objectPath, endpointUrl.origin)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(params.body)

  const signedHeaders = 'cache-control;content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = [
    `cache-control:${params.cacheControl}`,
    `content-type:${params.contentType}`,
    `host:${endpointUrl.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n')

  const canonicalRequest = [
    'PUT',
    targetUrl.pathname,
    '',
    canonicalHeaders,
    '',
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${params.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${params.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, params.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const response = await fetch(targetUrl, {
    method: 'PUT',
    headers: {
      'Cache-Control': params.cacheControl,
      'Content-Type': params.contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    body: new Uint8Array(params.body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`r2 upload failed (${response.status}) for ${params.key}: ${text}`)
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      unsigned: { type: 'boolean', default: false },
      upload: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  })
  const rawTarget = positionals[0]
  if (rawTarget === undefined || positionals.length !== 1 || !SUPPORTED_TARGETS.has(rawTarget as DesktopPackageTargetName)) {
    throw new Error('Usage: tsx scripts/stage-r2-feed.ts <mac-arm64|mac-x64|win-x64> [--unsigned] [--upload] [--out <dir>]')
  }
  const target = rawTarget as DesktopPackageTargetName
  const plan = await buildR2StagePlan(target, {
    unsigned: values.unsigned,
    ...(values.out === undefined ? {} : { stageRoot: resolve(values.out) }),
  })
  await writeR2StageFiles(plan)
  console.log(`R2 feed staged at: ${plan.stageRoot}`)
  console.log(`Feed metadata URL: ${plan.feedUrl}`)
  for (const file of plan.files) {
    console.log(`  - ${file.key}${file.isMetadata ? ' [metadata]' : ''}`)
  }

  if (values.upload) {
    const endpoint = process.env.R2_ENDPOINT_URL?.trim()
    const bucket = process.env.R2_BUCKET_NAME?.trim()
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
    const region = process.env.R2_REGION?.trim() || 'auto'
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('r2 upload requires R2_ENDPOINT_URL, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY')
    }
    for (const file of plan.files) {
      const stagedPath = join(plan.stageRoot, file.key)
      const body = await readFile(stagedPath)
      await uploadS3Object({
        endpoint,
        bucket,
        region,
        accessKeyId,
        secretAccessKey,
        key: file.key,
        body,
        contentType: file.contentType,
        cacheControl: file.cacheControl,
      })
      console.log(`Uploaded s3://${bucket}/${file.key}`)
    }
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
