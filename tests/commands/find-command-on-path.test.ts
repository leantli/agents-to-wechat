import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findBundledCommandPath,
  getManagedCodexAcpInstallRoot,
} from '../../src/commands/find-command-on-path.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('findBundledCommandPath', () => {
  it('finds the managed codex-acp binary inside node_modules/.bin', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    const binDir = join(tempDir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const binaryPath = join(binDir, 'codex-acp')
    await writeFile(binaryPath, '#!/usr/bin/env node\n')

    await expect(
      findBundledCommandPath('codex-acp', {
        projectRoot: tempDir,
        platform: 'darwin',
      })
    ).resolves.toBe(binaryPath)
  })

  it('does not treat unrelated commands as managed binaries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await expect(
      findBundledCommandPath('codex', {
        projectRoot: tempDir,
        platform: 'darwin',
      })
    ).resolves.toBeNull()
  })

  it('finds a repaired Windows launcher under the managed state directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    const stateDir = join(tempDir, 'state')
    const installRoot = getManagedCodexAcpInstallRoot(stateDir)
    const binDir = join(installRoot, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    const launcherPath = join(binDir, 'codex-acp.cmd')
    await writeFile(launcherPath, '@echo off\r\n')

    await expect(
      findBundledCommandPath('codex-acp', {
        projectRoot: tempDir,
        stateDir,
        platform: 'win32',
      })
    ).resolves.toBe(launcherPath)
  })
})
