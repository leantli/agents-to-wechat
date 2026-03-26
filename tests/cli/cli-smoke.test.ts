import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildCli, readPackageVersion } from '../../src/cli.js'
import { main } from '../../src/index.js'

const projectRoot = resolve(import.meta.dirname, '../..')

describe('buildCli', () => {
  it('uses the package version from package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {
      version?: string
    }

    expect(readPackageVersion()).toBe(pkg.version)
    expect(buildCli().version()).toBe(pkg.version)
  })

  it('prints a clean error and exits with code 1 when a command fails', async () => {
    let stderr = ''
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      stderr += chunk.toString()
      return true
    }) as never)
    const exit = vi.fn((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`)
    })

    try {
      await expect(
        main({
          argv: ['node', 'agents-to-wechat', 'start'],
          exit,
          runImpl: async () => {
            throw new Error('Agent command is not available on PATH: codex')
          },
        })
      ).rejects.toThrow('process.exit:1')
      expect(stderr).toBe('Agent command is not available on PATH: codex\n')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      write.mockRestore()
    }
  })
})
