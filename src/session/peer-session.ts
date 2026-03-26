import type {
  AgentAdapter,
  AgentCommandLogContext,
  AgentNativeCommandResult,
  AgentTurnKind,
} from '../agents/types.js'
import { extractNativeCommandName } from '../agents/native-command.js'
import type { RuntimeLogger } from '../logging/runtime-logger.js'
import {
  type CompletedPeerTurn,
  DEFAULT_FOLLOW_UP_ACK,
  type FailedPeerTurn,
  type AcceptInboundResult,
  type InboundPeerMessage,
  type PeerSessionSnapshot,
  type SessionErrorEvent,
} from './types.js'

interface QueuedPeerMessage {
  kind: AgentTurnKind
  text: string
  completionRefs: string[]
}

function mergePendingMessages(messages: QueuedPeerMessage[]): QueuedPeerMessage {
  return {
    kind: messages[0]?.kind ?? 'prompt',
    text: messages.map((message) => message.text).join('\n\n'),
    completionRefs: Array.from(new Set(messages.flatMap((message) => message.completionRefs))),
  }
}

function buildNativeCommandLogFields(
  input: QueuedPeerMessage,
  logContext?: AgentCommandLogContext
): Record<string, string | null | undefined> {
  if (input.kind !== 'native_command') {
    return {}
  }

  return {
    commandAction: logContext?.commandAction,
    commandName: logContext?.commandName ?? extractNativeCommandName(input.text),
    currentModelId: logContext?.currentModelId,
    requestedModel: logContext?.requestedModel,
    resolvedModel: logContext?.resolvedModel,
  }
}

export class PeerSession {
  private active = false
  private sessionId: string | null = null
  private pendingMessages: QueuedPeerMessage[] = []
  private readonly followUpAckMessage: string
  private readonly onTurnComplete?: (event: CompletedPeerTurn) => void | Promise<void>
  private readonly onTurnReply?: (event: CompletedPeerTurn) => void | Promise<void>
  private readonly onTurnFailure?: (event: FailedPeerTurn) => void | Promise<void>
  private readonly onSessionError?: (event: SessionErrorEvent) => void | Promise<void>

  constructor(
    private readonly peerId: string,
    private readonly adapter: AgentAdapter,
    followUpAckMessage = DEFAULT_FOLLOW_UP_ACK,
    onTurnComplete?: (event: CompletedPeerTurn) => void | Promise<void>,
    onTurnReply?: (event: CompletedPeerTurn) => void | Promise<void>,
    onTurnFailure?: (event: FailedPeerTurn) => void | Promise<void>,
    onSessionError?: (event: SessionErrorEvent) => void | Promise<void>,
    private readonly logger?: RuntimeLogger
  ) {
    this.followUpAckMessage = followUpAckMessage
    this.onTurnComplete = onTurnComplete
    this.onTurnReply = onTurnReply
    this.onTurnFailure = onTurnFailure
    this.onSessionError = onSessionError
  }

  acceptInbound(input: InboundPeerMessage): AcceptInboundResult {
    const nextMessage: QueuedPeerMessage = {
      kind: input.kind ?? 'prompt',
      text: input.text,
      completionRefs: input.completionRefs ?? [],
    }

    if (!this.active) {
      this.active = true
      const initialInput =
        this.pendingMessages.length > 0 ? this.mergePendingWith(nextMessage) : nextMessage

      void this.runTurn(initialInput).catch(async (error: unknown) => {
        this.active = false
        await this.onSessionError?.({
          peerId: this.peerId,
          error,
        })
      })

      return {
        started: true,
        followUpAck: null,
      }
    }

    const followUpAck = this.pendingMessages.length === 0 ? this.followUpAckMessage : null
    this.pendingMessages.push(nextMessage)

    return {
      started: false,
      followUpAck,
    }
  }

  peekPending(): string | null {
    return this.peekPendingGroup()?.text ?? null
  }

  private peekPendingKind(): AgentTurnKind | null {
    return this.peekPendingGroup()?.kind ?? null
  }

  snapshot(): PeerSessionSnapshot {
    return {
      peerId: this.peerId,
      active: this.active,
      pendingText: this.peekPending(),
      pendingKind: this.peekPendingKind(),
    }
  }

  private async ensureSessionId(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId
    }

    const sessionId = await this.adapter.createSession(this.peerId)
    this.sessionId = sessionId
    return sessionId
  }

  private drainPendingMessages(): QueuedPeerMessage | null {
    if (this.pendingMessages.length === 0) {
      return null
    }

    const firstKind = this.pendingMessages[0]?.kind
    const mergedGroup: QueuedPeerMessage[] = []

    while (this.pendingMessages[0]?.kind === firstKind) {
      const next = this.pendingMessages.shift()
      if (!next) {
        break
      }

      mergedGroup.push(next)
    }

    const merged = mergePendingMessages(mergedGroup)
    return merged
  }

  private peekPendingGroup(): QueuedPeerMessage | null {
    if (this.pendingMessages.length === 0) {
      return null
    }

    const firstKind = this.pendingMessages[0]?.kind
    return mergePendingMessages(
      this.pendingMessages
        .filter((message, index) => {
          if (index === 0) {
            return true
          }

          return message.kind === firstKind
        })
        .slice(0, this.countLeadingPendingMessagesOfSameKind(firstKind))
    )
  }

  private countLeadingPendingMessagesOfSameKind(kind: AgentTurnKind | undefined): number {
    let count = 0
    for (const message of this.pendingMessages) {
      if (message.kind !== kind) {
        break
      }

      count += 1
    }

    return count
  }

  private mergePendingWith(message: QueuedPeerMessage): QueuedPeerMessage {
    this.pendingMessages.push(message)
    return this.drainPendingMessages() ?? message
  }

  private requeueCurrentInput(input: QueuedPeerMessage): void {
    this.pendingMessages = [input, ...this.pendingMessages]
  }

  private async runAdapterTurn(
    sessionId: string,
    input: QueuedPeerMessage
  ): Promise<AgentNativeCommandResult> {
    if (input.kind === 'native_command') {
      if (!this.adapter.executeNativeCommand) {
        throw new Error('Agent adapter does not support native commands')
      }

      return await this.adapter.executeNativeCommand(sessionId, input.text)
    }

    if (this.adapter.sendPrompt) {
      return {
        status: 'completed',
        text: await this.adapter.sendPrompt(sessionId, input.text),
      }
    }

    throw new Error('Agent adapter does not support prompt turns')
  }

  private async runTurn(input: QueuedPeerMessage): Promise<void> {
    let currentInput = input

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      let reply: AgentNativeCommandResult
      try {
        const sessionId = await this.ensureSessionId()
        this.logger?.info('agent.turn.started', {
          peerId: this.peerId,
          sessionId,
          kind: currentInput.kind,
          textLength: currentInput.text.length,
          completionRefCount: currentInput.completionRefs.length,
          ...buildNativeCommandLogFields(currentInput),
        })
        reply = await this.runAdapterTurn(sessionId, currentInput)
      } catch (error) {
        this.logger?.error('agent.turn.failed', {
          peerId: this.peerId,
          kind: currentInput.kind,
          textLength: currentInput.text.length,
          ...buildNativeCommandLogFields(currentInput),
          error: error instanceof Error ? error.message : String(error),
        })

        try {
          await this.adapter.resetSession?.(this.peerId)
        } catch (resetError) {
          this.logger?.warn('agent.session.reset_failed', {
            peerId: this.peerId,
            error: resetError instanceof Error ? resetError.message : String(resetError),
          })
        }
        this.sessionId = null

        try {
          await this.onTurnFailure?.({
            peerId: this.peerId,
            kind: currentInput.kind,
            input: currentInput.text,
            completionRefs: currentInput.completionRefs,
            error,
          })
        } catch {
          // Failure notices are best-effort and must not pin the queue.
        }

        const nextInput = this.drainPendingMessages()
        if (nextInput === null) {
          this.active = false
          return
        }

        currentInput = nextInput
        continue
      }

      const event: CompletedPeerTurn = {
        peerId: this.peerId,
        kind: currentInput.kind,
        status: reply.status,
        text: reply.text,
        completionRefs: currentInput.completionRefs,
      }

      this.logger?.info('agent.turn.completed', {
        peerId: this.peerId,
        kind: currentInput.kind,
        status: reply.status,
        replyLength: reply.text.length,
        completionRefCount: currentInput.completionRefs.length,
        ...buildNativeCommandLogFields(currentInput, reply.logContext),
      })

      await this.onTurnComplete?.(event)

      try {
        await this.onTurnReply?.(event)
      } catch {
        // Reply delivery is best-effort and must not replay a completed turn.
      }

      const nextInput = this.drainPendingMessages()
      if (nextInput === null) {
        this.active = false
        return
      }

      currentInput = nextInput
    }
  }
}
