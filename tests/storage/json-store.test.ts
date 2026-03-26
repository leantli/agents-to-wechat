import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readJson, writeJson } from '../../src/storage/json-store.js'

describe('json store', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('round-trips JSON data and handles missing files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    const filePath = join(tempDir, 'state', 'token.json')

    expect(await readJson(filePath)).toBeNull()

    await writeJson(filePath, { token: 'abc', count: 1 })

    expect(await readJson(filePath)).toEqual({ token: 'abc', count: 1 })

    const [fileStat, dirStat] = await Promise.all([stat(filePath), stat(join(tempDir, 'state'))])

    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o077).toBe(0)
      expect(dirStat.mode & 0o077).toBe(0)
    }
  })
})
