import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { buildR2StagePlan, writeR2StageFiles } from '../scripts/stage-r2-feed.ts'

describe('stage-r2-feed', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('normalizes Windows generic feed YAML and orders binary before metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kwzg-r2-stage-'))
    dirs.push(root)
    const artifactsDir = join(root, 'artifacts')
    const stageRoot = join(root, 'stage')
    await (await import('node:fs/promises')).mkdir(artifactsDir, { recursive: true })

    const payload = Buffer.from('fake-installer-binary')
    const sha512 = createHash('sha512').update(payload).digest('base64')
    const exeName = 'deepseek-harness-0.2.2-rc.2-win-x64-unsigned.exe'
    await writeFile(join(artifactsDir, exeName), payload)
    await writeFile(join(artifactsDir, `${exeName}.blockmap`), Buffer.from('blockmap'))
    await writeFile(
      join(artifactsDir, 'nightly.yml'),
      [
        'version: 0.2.2-rc.2',
        'files:',
        `  - url: ${exeName}`,
        `    sha512: ${sha512}`,
        `    size: ${payload.length}`,
        `path: ${exeName}`,
        `sha512: ${sha512}`,
        "releaseDate: '2026-11-14T00:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    )

    const plan = await buildR2StagePlan('win-x64', {
      unsigned: true,
      artifactsDir,
      stageRoot,
      env: {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
        DOWNLOAD_PROD_ORIGIN: 'https://r2.zhoumaosen.top',
        DSH_DESKTOP_UPDATE_PREFIX: 'yizu/desktop',
      },
    })

    expect(plan.feedUrl).toBe('https://r2.zhoumaosen.top/yizu/desktop/feeds/win-x64/nightly.yml')
    expect(plan.files.map(f => f.key)).toEqual([
      `yizu/desktop/bin/win-x64/${exeName}`,
      `yizu/desktop/bin/win-x64/${exeName}.blockmap`,
      'yizu/desktop/feeds/win-x64/nightly.yml',
    ])
    expect(plan.files.at(-1)?.isMetadata).toBe(true)

    await writeR2StageFiles(plan)
    const yaml = load(await readFile(join(stageRoot, 'yizu/desktop/feeds/win-x64/nightly.yml'), 'utf8')) as {
      path: string
      files: Array<{ url: string }>
    }
    expect(yaml.files[0]?.url).toBe(`https://r2.zhoumaosen.top/yizu/desktop/bin/win-x64/${exeName}`)
    expect(yaml.path).toBe(`https://r2.zhoumaosen.top/yizu/desktop/bin/win-x64/${exeName}`)
  })

  it('enables generic R2 publish feed and mandatory policy for unsigned builds when opted in', () => {
    const winConfig = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_UPDATE_UNSIGNED: '1',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_PROD_ORIGIN: 'https://r2.zhoumaosen.top',
      DSH_DESKTOP_UPDATE_PREFIX: 'yizu/desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://kwzg.yizuw.cn',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
    }, 'win32', 'x64') as {
      publish: unknown
      extraMetadata: { dshMandatoryUpdatePolicy?: { origin: string } }
      win: { signtoolOptions: { publisherName?: string } }
    }
    expect(winConfig.publish).toEqual([{
      provider: 'generic',
      url: 'https://r2.zhoumaosen.top/yizu/desktop/feeds/win-x64/',
      channel: 'nightly',
    }])
    expect(winConfig.extraMetadata.dshMandatoryUpdatePolicy?.origin).toBe('https://kwzg.yizuw.cn')
    expect(winConfig.win.signtoolOptions.publisherName).toBeUndefined()

    const macConfig = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_UPDATE_UNSIGNED: '1',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_PROD_ORIGIN: 'https://r2.zhoumaosen.top',
      DSH_DESKTOP_UPDATE_PREFIX: 'yizu/desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://kwzg.yizuw.cn',
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'arm64',
    }, 'darwin', 'arm64') as unknown as {
      publish: unknown
      mac: { target: string[] }
      extraMetadata: { dshMandatoryUpdatePolicy?: { origin: string } }
    }
    expect(macConfig.publish).toEqual([{
      provider: 'generic',
      url: 'https://r2.zhoumaosen.top/yizu/desktop/feeds/mac-arm64/',
      channel: 'nightly',
    }])
    expect(macConfig.mac.target).toEqual(['dmg', 'zip'])
    expect(macConfig.extraMetadata.dshMandatoryUpdatePolicy?.origin).toBe('https://kwzg.yizuw.cn')
  })
})
