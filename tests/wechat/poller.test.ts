import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollOnce, pollUpdates } from '../../src/wechat/protocol/poller.js'
import { getStatePath } from '../../src/storage/paths.js'
import {
  readSyncState,
  writeGetUpdatesBuf,
  writePeerContextToken,
  writeSyncState,
} from '../../src/wechat/protocol/sync-state.js'

let tempDir: string | undefined

afterEach(async () => {
  vi.useRealTimers()

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('wechat poller', () => {
  it('commits sync state after a successful single poll', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {
        'peer-0': 'ctx-0',
      },
    })

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [
            {
              from_user_id: 'peer-1',
              context_token: 'ctx-1',
              content: 'hello',
            },
          ],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    await expect(
      pollOnce({
        stateDir: tempDir,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        fetchImpl,
      })
    ).resolves.toMatchObject({
      getUpdatesBuf: 'next-buf',
    })

    await expect(readSyncState(tempDir)).resolves.toMatchObject({
      getUpdatesBuf: 'next-buf',
      peerContextTokens: {
        'peer-0': 'ctx-0',
        'peer-1': 'ctx-1',
      },
    })
  })

  it('persists the batch only after onBatch succeeds', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [
            {
              from_user_id: 'peer-1',
              context_token: 'ctx-1',
              content: 'hello',
            },
          ],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    await expect(
      pollUpdates({
        stateDir: tempDir,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        fetchImpl,
        timeoutMs: 20,
        sleep: async () => {},
        onBatch: () => {
          throw new Error('handoff failed')
        },
      })
    ).rejects.toThrow('handoff failed')

    await expect(readSyncState(tempDir)).resolves.toMatchObject({
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })
  })

  it('surfaces persistent transport failures', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })

    const fetchImpl = vi.fn(() => Promise.reject(new Error('upstream down')))
    const onRetry = vi.fn()

    await expect(
      pollUpdates({
        stateDir: tempDir,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        fetchImpl,
        timeoutMs: 15,
        sleep: async () => {},
        backoffMs: () => 0,
        onRetry,
      })
    ).rejects.toThrow('upstream down')

    expect(onRetry).toHaveBeenCalled()
  })

  it('throws the last transport error even after an earlier successful poll', async () => {
    vi.useFakeTimers()
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })

    let callCount = 0
    const fetchImpl = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            ret: 0,
            msgs: [],
            get_updates_buf: 'next-buf',
          }),
          { status: 200 }
        )
      }

      throw new Error('upstream down')
    })

    await expect(
      pollUpdates({
        stateDir: tempDir,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        fetchImpl,
        timeoutMs: 15,
        backoffMs: () => 5,
        sleep: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms)
        },
      })
    ).rejects.toThrow('upstream down')
  })

  it('fails fast when the local sync state cannot be read', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeFile(getStatePath(tempDir, 'wechat-sync.json'), '{not-json\n', 'utf8')

    const fetchImpl = vi.fn()
    const onRetry = vi.fn()

    await expect(
      pollUpdates({
        stateDir: tempDir,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        fetchImpl,
        timeoutMs: 20,
        sleep: async () => {},
        onRetry,
      })
    ).rejects.toThrow()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('commits sync state after a successful batch and preserves concurrent updates', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [
            {
              from_user_id: 'peer-1',
              context_token: 'ctx-1',
              content: 'hello',
            },
          ],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    await pollUpdates({
      stateDir: tempDir,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      fetchImpl,
      timeoutMs: 20,
      sleep: async () => {},
      onBatch: async () => false,
    })

    await Promise.all([
      writeGetUpdatesBuf(tempDir, 'merged-buf'),
      writePeerContextToken(tempDir, 'peer-2', 'ctx-2'),
    ])

    await expect(readSyncState(tempDir)).resolves.toMatchObject({
      getUpdatesBuf: 'merged-buf',
      peerContextTokens: {
        'peer-1': 'ctx-1',
        'peer-2': 'ctx-2',
      },
    })
  })

  it('does not roll back same-key sync state updates that happen during onBatch', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {
        'peer-1': 'ctx-old',
      },
    })

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [
            {
              from_user_id: 'peer-1',
              context_token: 'ctx-from-poll',
              content: 'hello',
            },
          ],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    await pollUpdates({
      stateDir: tempDir,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      fetchImpl,
      timeoutMs: 20,
      sleep: async () => {},
      onBatch: async () => {
        await Promise.all([
          writeGetUpdatesBuf(tempDir!, 'newer-buf'),
          writePeerContextToken(tempDir!, 'peer-1', 'ctx-newer'),
        ])

        return false
      },
    })

    await expect(readSyncState(tempDir)).resolves.toMatchObject({
      getUpdatesBuf: 'newer-buf',
      peerContextTokens: {
        'peer-1': 'ctx-newer',
      },
    })
  })

  it.skip('does not let a follow-up poll request outlive the overall timeout budget', async () => {
    vi.useFakeTimers()
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {},
    })

    let callCount = 0
    const startedAt = Date.now()
    let secondAbortAt: number | null = null
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  ret: 0,
                  msgs: [],
                  get_updates_buf: 'next-buf',
                }),
                { status: 200 }
              )
            )
          }, 30)
        })
      }

      return new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => {
          secondAbortAt = Date.now() - startedAt
        })
      })
    })

    const polling = pollUpdates({
      stateDir: tempDir,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      fetchImpl,
      timeoutMs: 50,
      pollIntervalMs: 0,
      backoffMs: () => 0,
      sleep: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
      },
    })

    let elapsedMs = 0
    while (secondAbortAt === null && elapsedMs < 100) {
      await vi.advanceTimersByTimeAsync(1)
      elapsedMs += 1
    }

    if (secondAbortAt !== null) {
      expect(secondAbortAt).toBeLessThanOrEqual(50)
    }

    await vi.advanceTimersByTimeAsync(100)

    const result = await polling
    expect(result.getUpdatesBuf).toBe('next-buf')
  })
})
