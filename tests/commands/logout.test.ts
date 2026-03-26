import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runLogout } from '../../src/commands/logout.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('runLogout', () => {
  it('removes saved login and sync state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(tempDir, 'wechat-auth.json'), '{}')
    await writeFile(join(tempDir, 'wechat-sync.json'), '{}')

    const result = await runLogout({
      stateDir: tempDir,
    })

    expect(result.removed).toBe(true)
    await expect(readFile(join(tempDir, 'wechat-auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(tempDir, 'wechat-sync.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reports no-op when nothing is stored', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const result = await runLogout({
      stateDir: tempDir,
    })

    expect(result.removed).toBe(false)
  })

  it('surfaces non-ENOENT access errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await expect(
      runLogout({
        stateDir: tempDir,
        accessImpl: async () => {
          const error = new Error('permission denied') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        },
      })
    ).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('surfaces non-ENOENT remove errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await expect(
      runLogout({
        stateDir: tempDir,
        accessImpl: async () => undefined,
        rmImpl: async () => {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        },
      })
    ).rejects.toMatchObject({
      code: 'EPERM',
    })
  })
})
