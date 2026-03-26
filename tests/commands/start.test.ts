import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStart } from '../../src/commands/start.js'

let tempDir: string | undefined
const EMPTY_PROJECT_ROOT = '/definitely-missing-agent-to-wechat-project-root'

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('runStart', () => {
  it('fails fast when codex-acp is unavailable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await expect(
      runStart({
        stateDir: tempDir,
        execInstallImpl: vi.fn(async () => undefined),
        projectRoot: EMPTY_PROJECT_ROOT,
        whichImpl: vi.fn(async (command: string) => {
          if (command === 'codex') {
            return '/usr/local/bin/codex'
          }

          return null
        }),
      })
    ).rejects.toThrow('codex-acp is not available after repair install')
  })

  it('fails fast when the configured agent command is missing from PATH', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await expect(
      runStart({
        stateDir: tempDir,
        command: 'agent-to-wechat-missing-command-for-start-test',
      })
    ).rejects.toThrow(
      'Agent command is not available on PATH: agent-to-wechat-missing-command-for-start-test'
    )
  })
})
