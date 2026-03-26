import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeLogger } from '../../src/logging/runtime-logger.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('createRuntimeLogger', () => {
  it('mirrors log lines to the terminal and the fixed log file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agents-to-wechat-log-'))

    const consoleImpl = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const logger = createRuntimeLogger({
      stateDir: tempDir,
      consoleImpl,
    })

    logger.info('inbound.received', {
      peerId: 'u1',
      text: 'hello world',
    })
    logger.warn('wechat.send.failed', {
      peerId: 'u1',
      error: 'boom',
    })
    await logger.flush()

    const fileText = await readFile(join(tempDir, 'agents-to-wechat.log'), 'utf8')

    expect(logger.logPath).toBe(join(tempDir, 'agents-to-wechat.log'))
    expect(consoleImpl.log).toHaveBeenCalledWith(expect.stringContaining('INFO inbound.received'))
    expect(consoleImpl.warn).toHaveBeenCalledWith(
      expect.stringContaining('WARN wechat.send.failed')
    )
    expect(fileText).toContain('INFO inbound.received')
    expect(fileText).toContain('WARN wechat.send.failed')
    expect(fileText).toContain('peerId="u1"')
    expect(fileText).toContain('text="hello world"')
    expect(fileText).toContain('error="boom"')
  })

  it('keeps the log directory and file private to the current user', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agents-to-wechat-log-'))

    const logger = createRuntimeLogger({
      stateDir: tempDir,
      consoleImpl: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    })

    logger.info('service.starting')
    await logger.flush()

    const [fileStat, dirStat] = await Promise.all([
      stat(join(tempDir, 'agents-to-wechat.log')),
      stat(tempDir),
    ])

    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o077).toBe(0)
      expect(dirStat.mode & 0o077).toBe(0)
    }
  })
})
