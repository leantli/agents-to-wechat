import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter } from '../../src/agents/mock-adapter.js'
import { createStartService } from '../../src/app/start-service.js'
import type { RuntimeLogger } from '../../src/logging/runtime-logger.js'
import type { GetUpdatesResponse } from '../../src/wechat/protocol/messages.js'
import { readSyncState } from '../../src/wechat/protocol/sync-state.js'
import type { PollUpdatesInput } from '../../src/wechat/protocol/poller.js'

let tempDir: string | undefined

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushAsyncWork(): Promise<void> {
  await flushMicrotasks()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await flushMicrotasks()
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('createStartService', () => {
  it('logs inbound acceptance and reply delivery', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const logger: RuntimeLogger = {
      logPath: join(tempDir, 'agent-to-wechat.log'),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => undefined),
    }
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
      logger,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'hello',
      contextToken: 'ctx-1',
      dedupeKey: 'msg-1',
    })
    await flushAsyncWork()

    expect(logger.info).toHaveBeenCalledWith(
      'inbound.accepted',
      expect.objectContaining({
        peerId: 'u1',
        dedupeKey: 'msg-1',
      })
    )

    adapter.resolveNextTurn('u1', 'final reply')
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: 'final reply',
        })
      )
    })

    expect(logger.info).toHaveBeenCalledWith(
      'wechat.send.succeeded',
      expect.objectContaining({
        peerId: 'u1',
        reason: 'agent_reply',
      })
    )
  })

  it('routes inbound messages into the session manager and sends replies', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'hello',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    adapter.resolveNextTurn('u1', 'final reply')
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: 'final reply',
        })
      )
    })
  })

  it('passes slash commands through to the agent unchanged', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const logger: RuntimeLogger = {
      logPath: join(tempDir, 'agent-to-wechat.log'),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => undefined),
    }
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl: vi.fn(async () => undefined),
      logger,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: '/new',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0]).toMatchObject({
      input: '/new',
      kind: 'native_command',
    })
    expect(logger.info).toHaveBeenCalledWith(
      'inbound.accepted',
      expect.objectContaining({
        commandName: '/new',
        peerId: 'u1',
        kind: 'native_command',
      })
    )
  })

  it('sends a Chinese unsupported-command reply when the agent reports unsupported_command', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: '/model',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    adapter.resolveNextTurn('u1', '当前 agent 不支持这个命令：/model', 'unsupported_command')
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: '当前 agent 不支持这个命令：/model',
        })
      )
    })

    expect(adapter.turns[0]).toMatchObject({
      input: '/model',
      kind: 'native_command',
    })
  })

  it('sends a queued follow-up acknowledgement and replies with the latest context token', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'first',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    await service.handleInbound({
      peerId: 'u1',
      text: 'second',
      contextToken: 'ctx-2',
    })

    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-2',
          text: expect.stringContaining('处理中'),
        })
      )
    })

    adapter.resolveNextTurn('u1', 'first reply')
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-2',
          text: 'first reply',
        })
      )
    })
  })

  it('does not duplicate a queued follow-up when acknowledgement delivery fails', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async (message: { text: string }) => {
      if (message.text.includes('处理中')) {
        throw new Error('ack failed')
      }
    })
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'first',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    await expect(
      service.handleInbound({
        peerId: 'u1',
        text: 'second',
        contextToken: 'ctx-2',
      })
    ).resolves.toBeUndefined()

    adapter.resolveNextTurn('u1', 'first reply')
    await vi.waitFor(() => {
      expect(adapter.turns).toHaveLength(2)
    })
    expect(adapter.turns[1]?.input).toBe('second')
  })

  it('sends a failure notice and continues draining queued follow-ups', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'first',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    await service.handleInbound({
      peerId: 'u1',
      text: 'second',
      contextToken: 'ctx-2',
    })

    adapter.rejectNextTurn('u1', new Error('turn failed'))
    await flushAsyncWork()

    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-2',
          text: expect.stringContaining('失败'),
        })
      )
    })

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[1]?.input).toBe('second')
  })

  it('marks a failed id-backed inbound as completed so restart recovery does not replay it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const firstService = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await firstService.handleInbound({
      peerId: 'u1',
      text: 'first',
      contextToken: 'ctx-1',
      dedupeKey: 'msg-1',
    })
    await flushAsyncWork()

    adapter.rejectNextTurn('u1', new Error('turn failed'))
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: expect.stringContaining('失败'),
        })
      )
    })

    await expect(readSyncState(tempDir)).resolves.toMatchObject({
      handledInboundIds: ['u1\u0000msg-1'],
      pendingInbounds: [],
    })

    const secondAdapter = new MockAdapter()
    const secondService = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter: secondAdapter,
      sendMessageImpl,
      pollUpdatesImpl: vi.fn(async ({ onBatch }: PollUpdatesInput) => {
        const response: GetUpdatesResponse = {
          ret: 0,
          getUpdatesBuf: 'buf-1',
          msgs: [],
        }

        await onBatch?.(response)
        return response
      }),
    })

    await secondService.pollOnce()
    await flushAsyncWork()

    expect(secondAdapter.turns).toHaveLength(0)
  })

  it('sends a Chinese startup-failure notice when the local agent cannot be launched', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'hello',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    adapter.rejectNextTurn('u1', new Error('spawn failed'))
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: '本地代理启动失败，请确认本地环境已安装并配置正确后重试。',
        })
      )
    })
  })

  it('sends a Chinese no-response notice when the agent returns no reply', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'hello',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    adapter.rejectNextTurn('u1', new Error('Codex completed without an agent message'))
    await vi.waitFor(() => {
      expect(sendMessageImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'u1',
          contextToken: 'ctx-1',
          text: '这次没有收到代理返回内容，请稍后重试。',
        })
      )
    })
  })

  it('ignores a replayed inbound message instead of queueing it twice', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'first',
      contextToken: 'ctx-1',
    })
    await flushAsyncWork()

    await service.handleInbound({
      peerId: 'u1',
      text: 'second',
      contextToken: 'ctx-2',
      dedupeKey: 'msg-2',
    })
    await service.handleInbound({
      peerId: 'u1',
      text: 'second',
      contextToken: 'ctx-2',
      dedupeKey: 'msg-2',
    })

    adapter.resolveNextTurn('u1', 'first reply')
    await vi.waitFor(() => {
      expect(adapter.turns).toHaveLength(2)
    })

    expect(adapter.turns[1]?.input).toBe('second')
  })

  it('does not dedupe repeated text updates that do not carry a message id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const pollUpdatesImpl = vi.fn(async ({ onBatch }: PollUpdatesInput) => {
      const response: GetUpdatesResponse = {
        ret: 0,
        getUpdatesBuf: 'buf-1',
        msgs: [
          {
            from_user_id: 'u1',
            context_token: 'ctx-1',
            content: 'same text',
          },
          {
            from_user_id: 'u1',
            context_token: 'ctx-1',
            content: 'same text',
          },
        ],
      }

      await onBatch?.(response)
      return response
    })
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
      pollUpdatesImpl,
    })

    await service.pollOnce()
    await flushAsyncWork()

    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0]?.input).toBe('same text')

    adapter.resolveNextTurn('u1', 'first reply')
    await vi.waitFor(() => {
      expect(adapter.turns).toHaveLength(2)
    })
    expect(adapter.turns[1]?.input).toBe('same text')
  })

  it('extracts inbound text from item_list and accepts message_id as the replay key', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const pollUpdatesImpl = vi.fn(async ({ onBatch }: PollUpdatesInput) => {
      const response: GetUpdatesResponse = {
        ret: 0,
        getUpdatesBuf: 'buf-1',
        msgs: [
          {
            message_id: 101,
            from_user_id: 'u1',
            context_token: 'ctx-1',
            item_list: [
              {
                type: 1,
                text_item: {
                  text: 'hello from item list',
                },
              },
            ],
          },
        ],
      }

      await onBatch?.(response)
      return response
    })
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
      pollUpdatesImpl,
    })

    await service.pollOnce()
    await flushAsyncWork()

    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0]).toMatchObject({
      peerId: 'u1',
      input: 'hello from item list',
    })
  })

  it('recovers a pending id-backed update after restart without queueing the replay twice', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const pollUpdatesImpl = vi.fn(async ({ onBatch }: PollUpdatesInput) => {
      const response: GetUpdatesResponse = {
        ret: 0,
        getUpdatesBuf: 'buf-1',
        msgs: [
          {
            msg_id: 'msg-1',
            from_user_id: 'u1',
            context_token: 'ctx-1',
            content: 'hello',
          },
        ],
      }

      await onBatch?.(response)
      return response
    })
    const firstAdapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const firstService = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter: firstAdapter,
      sendMessageImpl,
      pollUpdatesImpl,
    })

    await firstService.pollOnce()
    await flushAsyncWork()

    expect(firstAdapter.turns).toHaveLength(1)

    const secondAdapter = new MockAdapter()
    const secondService = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter: secondAdapter,
      sendMessageImpl,
      pollUpdatesImpl,
    })

    await secondService.pollOnce()
    await flushAsyncWork()

    expect(secondAdapter.turns).toHaveLength(1)
    expect(secondAdapter.turns[0]).toMatchObject({
      peerId: 'u1',
      input: 'hello',
    })
  })

  it('does not let different peers collide on the same raw message id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const sendMessageImpl = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      sendMessageImpl,
    })

    await service.handleInbound({
      peerId: 'u1',
      text: 'hello from u1',
      contextToken: 'ctx-1',
      dedupeKey: 'msg-1',
    })
    await service.handleInbound({
      peerId: 'u2',
      text: 'hello from u2',
      contextToken: 'ctx-2',
      dedupeKey: 'msg-1',
    })
    await flushAsyncWork()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[0]).toMatchObject({
      peerId: 'u1',
      input: 'hello from u1',
    })
    expect(adapter.turns[1]).toMatchObject({
      peerId: 'u2',
      input: 'hello from u2',
    })
  })

  it('keeps the service loop running across retryable poll transport errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const adapter = new MockAdapter()
    const logger: RuntimeLogger = {
      logPath: join(tempDir, 'agent-to-wechat.log'),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => undefined),
    }
    let callCount = 0
    const pollUpdatesImpl = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) {
        const error = new Error('fetch failed')
        ;(error as Error & { cause?: unknown }).cause = { code: 'ECONNRESET' }
        throw error
      }

      throw new Error('stop loop')
    })
    const sleep = vi.fn(async () => undefined)
    const service = createStartService({
      stateDir: tempDir,
      loginState: {
        botToken: 'bot-token',
        botAccountId: 'bot-account',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
      adapter,
      logger,
      pollUpdatesImpl,
      sleep,
      pollErrorBackoffMs: 0,
    })

    await expect(service.start()).rejects.toThrow('stop loop')

    expect(pollUpdatesImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.retrying',
      expect.objectContaining({
        error: 'fetch failed',
      })
    )
  })
})
