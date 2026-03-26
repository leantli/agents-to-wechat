import { describe, expect, it, vi } from 'vitest'
import type {
  AgentAdapter,
  AgentCommandLogContext,
  AgentNativeCommandResult,
  AgentTurnKind,
  AgentTurnRecord,
} from '../../src/agents/types.js'
import { SessionManager } from '../../src/session/session-manager.js'

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

interface PendingTurn {
  peerId: string
  kind: AgentTurnKind
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

class QueueingAdapter implements AgentAdapter {
  public readonly turns: AgentTurnRecord[] = []
  public readonly createSessionCalls = new Map<string, number>()

  private readonly sessionIds = new Map<string, string>()
  private readonly pendingTurns = new Map<string, PendingTurn[]>()

  createSession(peerId: string): string {
    this.createSessionCalls.set(peerId, (this.createSessionCalls.get(peerId) ?? 0) + 1)
    const existing = this.sessionIds.get(peerId)
    if (existing) {
      return existing
    }

    const sessionId = `session-${peerId}`
    this.sessionIds.set(peerId, sessionId)
    return sessionId
  }

  async sendPrompt(sessionId: string, input: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.enqueue(
        sessionId,
        'prompt',
        input,
        (value) => {
          resolve(value as string)
        },
        reject
      )
    })
  }

  async executeNativeCommand(sessionId: string, input: string): Promise<AgentNativeCommandResult> {
    return await new Promise<AgentNativeCommandResult>((resolve, reject) => {
      this.enqueue(
        sessionId,
        'native_command',
        input,
        (value) => {
          resolve(value as AgentNativeCommandResult)
        },
        reject
      )
    })
  }

  resolveNextTurn(
    peerId: string,
    value: string,
    status: AgentNativeCommandResult['status'] = 'completed',
    logContext?: AgentCommandLogContext
  ): void {
    const next = this.shiftPending(peerId)
    if (next.kind === 'prompt') {
      next.resolve(value)
      return
    }

    next.resolve({
      logContext,
      status,
      text: value,
    })
  }

  rejectNextTurn(peerId: string, error: unknown): void {
    const next = this.shiftPending(peerId)
    next.reject(error)
  }

  private enqueue(
    sessionId: string,
    kind: AgentTurnKind,
    input: string,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void
  ): void {
    const peerId = sessionId.replace(/^session-/, '')
    this.turns.push({
      peerId,
      sessionId,
      input,
      kind,
    })

    const queue = this.pendingTurns.get(peerId) ?? []
    queue.push({
      peerId,
      kind,
      resolve,
      reject,
    })
    this.pendingTurns.set(peerId, queue)
  }

  resetSession(peerId: string): void {
    this.sessionIds.delete(peerId)
  }

  private shiftPending(peerId: string): PendingTurn {
    const queue = this.pendingTurns.get(peerId)
    const next = queue?.shift()
    if (!next) {
      throw new Error(`No pending mock turn for peer ${peerId}`)
    }

    if (queue && queue.length === 0) {
      this.pendingTurns.delete(peerId)
    }

    return next
  }
}

class DeferredCreateSessionAdapter implements AgentAdapter {
  public readonly turns: AgentTurnRecord[] = []

  private readonly sessionIds = new Map<string, string>()
  private heldCreate:
    | {
        peerId: string
        reject: (error: unknown) => void
      }
    | undefined

  holdNextCreateSession(peerId: string): void {
    this.heldCreate = {
      peerId,
      reject: () => undefined,
    }
  }

  rejectHeldCreateSession(error: unknown): void {
    if (!this.heldCreate) {
      throw new Error('No held createSession call to reject')
    }

    this.heldCreate.reject(error)
    this.heldCreate = undefined
  }

  createSession(peerId: string): string | Promise<string> {
    const existing = this.sessionIds.get(peerId)
    if (existing) {
      return existing
    }

    if (this.heldCreate?.peerId === peerId) {
      return new Promise<string>((_resolve, reject) => {
        this.heldCreate = {
          peerId,
          reject,
        }
      })
    }

    const sessionId = `session-${peerId}`
    this.sessionIds.set(peerId, sessionId)
    return sessionId
  }

  async sendPrompt(sessionId: string, input: string): Promise<string> {
    const peerId = sessionId.replace(/^session-/, '')
    this.turns.push({
      peerId,
      sessionId,
      input,
      kind: 'prompt',
    })

    return 'ok'
  }

  async executeNativeCommand(): Promise<AgentNativeCommandResult> {
    throw new Error('Not used in this test adapter')
  }
}

describe('SessionManager', () => {
  it('queues and merges prompt follow-up messages while a turn is running', async () => {
    const adapter = new QueueingAdapter()
    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    manager.acceptInbound({ peerId: 'u1', text: 'third' })

    expect(manager.peekPending('u1')).toContain('second')
    expect(manager.peekPending('u1')).toContain('third')
  })

  it('returns an acknowledgement only for the first follow-up', async () => {
    const adapter = new QueueingAdapter()
    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    const firstFollowUp = manager.acceptInbound({ peerId: 'u1', text: 'second' })
    const secondFollowUp = manager.acceptInbound({ peerId: 'u1', text: 'third' })

    expect(firstFollowUp.followUpAck).toContain('处理中')
    expect(secondFollowUp.followUpAck).toBeNull()
  })

  it('starts the merged prompt follow-up after the active prompt resolves', async () => {
    const adapter = new QueueingAdapter()
    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    manager.acceptInbound({ peerId: 'u1', text: 'third' })

    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0]).toMatchObject({
      input: 'first',
      kind: 'prompt',
    })

    adapter.resolveNextTurn('u1', 'done-1')
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[1]).toMatchObject({
      kind: 'prompt',
    })
    expect(adapter.turns[1]?.input).toContain('second')
    expect(adapter.turns[1]?.input).toContain('third')
  })

  it('keeps native commands and prompts separate when both are queued', async () => {
    const adapter = new QueueingAdapter()
    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: '/model', kind: 'native_command' })
    manager.acceptInbound({ peerId: 'u1', text: 'second prompt' })

    adapter.resolveNextTurn('u1', 'done-1')
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[1]).toMatchObject({
      kind: 'native_command',
      input: '/model',
    })

    adapter.resolveNextTurn('u1', '当前模型：Codex')
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(3)
    expect(adapter.turns[2]).toMatchObject({
      kind: 'prompt',
      input: 'second prompt',
    })
  })

  it('drops the failed first turn and keeps processing later messages after session creation fails', async () => {
    const adapter = new DeferredCreateSessionAdapter()
    adapter.holdNextCreateSession('u1')

    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    adapter.rejectHeldCreateSession(new Error('create failed'))
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'third' })
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[0]?.input).toBe('second')
    expect(adapter.turns[1]?.input).toBe('third')
  })

  it('reports the failed active prompt turn and continues with later follow-ups', async () => {
    const adapter = new QueueingAdapter()
    const onTurnFailure = vi.fn(async () => undefined)
    const manager = new SessionManager({
      adapter,
      onTurnFailure,
    })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    adapter.rejectNextTurn('u1', new Error('turn failed'))
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[1]).toMatchObject({
      input: 'second',
      kind: 'prompt',
    })
    expect(onTurnFailure).toHaveBeenCalledTimes(1)
    expect(onTurnFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'u1',
        kind: 'prompt',
      })
    )
  })

  it('recreates the peer session after a failed turn before processing later messages', async () => {
    const adapter = new QueueingAdapter()
    const manager = new SessionManager({ adapter })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    adapter.rejectNextTurn('u1', new Error('turn failed'))
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[0]).toMatchObject({
      sessionId: 'session-u1',
      input: 'first',
    })
    expect(adapter.turns[1]).toMatchObject({
      sessionId: 'session-u1',
      input: 'second',
    })
    expect(adapter.createSessionCalls.get('u1')).toBe(2)
  })

  it('keeps draining follow-ups even if the reply callback fails', async () => {
    const adapter = new QueueingAdapter()
    const onTurnReply = vi.fn(async () => {
      throw new Error('delivery failed')
    })
    const manager = new SessionManager({
      adapter,
      onTurnReply,
    })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    adapter.resolveNextTurn('u1', 'first reply')
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(2)
    expect(adapter.turns[1]).toMatchObject({
      input: 'second',
      kind: 'prompt',
    })
    expect(onTurnReply).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported command status through the reply callback', async () => {
    const adapter = new QueueingAdapter()
    const onTurnReply = vi.fn(async () => undefined)
    const manager = new SessionManager({
      adapter,
      onTurnReply,
    })

    manager.acceptInbound({ peerId: 'u1', text: '/model', kind: 'native_command' })
    await flushMicrotasks()

    adapter.resolveNextTurn('u1', '当前模型：Codex', 'unsupported_command')
    await flushMicrotasks()

    expect(onTurnReply).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'u1',
        kind: 'native_command',
        status: 'unsupported_command',
        text: '当前模型：Codex',
      })
    )
  })

  it('logs native command details without logging full command text', async () => {
    const adapter = new QueueingAdapter()
    const logger = {
      logPath: '/tmp/agent-to-wechat.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => undefined),
    }
    const manager = new SessionManager({
      adapter,
      logger,
    })

    manager.acceptInbound({ peerId: 'u1', text: '/model gpt-5.4/high', kind: 'native_command' })
    await flushMicrotasks()

    adapter.resolveNextTurn('u1', '已切换到模型：gpt-5.4/high', 'completed', {
      commandAction: 'set_model',
      commandName: '/model',
      currentModelId: 'gpt-5.4/high',
      requestedModel: 'gpt-5.4/high',
      resolvedModel: 'gpt-5.4/high',
    })
    await flushMicrotasks()

    expect(logger.info).toHaveBeenCalledWith(
      'agent.turn.started',
      expect.objectContaining({
        commandName: '/model',
        kind: 'native_command',
        peerId: 'u1',
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'agent.turn.completed',
      expect.objectContaining({
        commandAction: 'set_model',
        commandName: '/model',
        currentModelId: 'gpt-5.4/high',
        kind: 'native_command',
        peerId: 'u1',
        requestedModel: 'gpt-5.4/high',
        resolvedModel: 'gpt-5.4/high',
      })
    )
  })

  it('reports completion callback failures without draining queued follow-ups', async () => {
    const adapter = new QueueingAdapter()
    const onTurnComplete = vi.fn(async () => {
      throw new Error('state write failed')
    })
    const onSessionError = vi.fn()
    const manager = new SessionManager({
      adapter,
      onTurnComplete,
      onSessionError,
    })

    manager.acceptInbound({ peerId: 'u1', text: 'first' })
    await flushMicrotasks()

    manager.acceptInbound({ peerId: 'u1', text: 'second' })
    adapter.resolveNextTurn('u1', 'first reply')
    await flushMicrotasks()

    expect(adapter.turns).toHaveLength(1)
    expect(manager.peekPending('u1')).toBe('second')
    expect(onSessionError).toHaveBeenCalledTimes(1)
  })
})
