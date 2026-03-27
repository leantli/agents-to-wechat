import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../../src/commands/doctor.js'

let tempDir: string | undefined
const EMPTY_PROJECT_ROOT = '/definitely-missing-agent-to-wechat-project-root'

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('runDoctor', () => {
  it('reports codex-acp separately when it is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    const execInstallImpl = vi.fn(async () => undefined)
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl,
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.check)).toContain('codex-acp')
    expect(result.issues.find((issue) => issue.check === 'codex-acp')?.message).toBe(
      'codex-acp is not available'
    )
    expect(execInstallImpl).not.toHaveBeenCalled()
  })

  it('reports malformed login credentials clearly', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'not-a-url',
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return null
        }

        if (command === 'codex-acp') {
          return '/tmp/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.check)).toEqual(
      expect.arrayContaining(['codex', 'login'])
    )
    expect(result.issues.map((issue) => issue.check)).not.toContain('codex-acp')
    expect(result.issues.map((issue) => issue.check)).not.toContain('sync')
  })

  it('reports codex-acp startup failures clearly when validation fails', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => {
        throw new Error('exit code 42')
      }),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.find((issue) => issue.check === 'codex-acp')?.message).toBe(
      'codex-acp failed to start: exit code 42'
    )
  })

  it('fails when sync-state JSON is unreadable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )
    await writeFile(join(tempDir, 'wechat-sync.json'), '{not-json\n')

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.check)).toContain('sync')
  })

  it('passes when sync-state is partial but runtime-normalizable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )
    await writeFile(join(tempDir, 'wechat-sync.json'), JSON.stringify({}))

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('fails when sync-state is parseable but has wrong field types', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )
    await writeFile(
      join(tempDir, 'wechat-sync.json'),
      JSON.stringify({
        getUpdatesBuf: 123,
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.check)).toContain('sync')
  })

  it('passes when Node, codex, config, and login state are healthy even without sync-state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.12.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('fails on unsupported Node 23.x even when other checks are healthy', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      join(tempDir, 'wechat-auth.json'),
      JSON.stringify({
        botToken: 'token',
        botAccountId: 'bot',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      })
    )

    const result = await runDoctor({
      stateDir: tempDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v23.1.0',
      execInstallImpl: vi.fn(async () => undefined),
      validateImpl: vi.fn(async () => undefined),
      projectRoot: EMPTY_PROJECT_ROOT,
      whichImpl: vi.fn(async (command: string) => {
        if (command === 'codex') {
          return '/usr/local/bin/codex'
        }

        if (command === 'codex-acp') {
          return '/usr/local/bin/codex-acp'
        }

        return null
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.issues.find((issue) => issue.check === 'node')?.message).toBe(
      'Node.js 22.12+ LTS or 24+ is required, found v23.1.0'
    )
  })
})
