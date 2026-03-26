import type { AgentAdapter } from '../agents/types.js'
import { routeInboundText } from './command-router.js'
import type { RuntimeLogger } from '../logging/runtime-logger.js'
import { extractNativeCommandName } from '../agents/native-command.js'
import { SessionManager } from '../session/session-manager.js'
import { readLoginState } from '../wechat/auth/login.js'
import { sendMessage } from '../wechat/protocol/messages.js'
import { pollUpdates } from '../wechat/protocol/poller.js'
import {
  completeInboundMessages,
  readPeerContextToken,
  readPendingInbounds,
  recordInboundMessage,
} from '../wechat/protocol/sync-state.js'
import type { FetchImpl, SavedLoginState } from '../wechat/protocol/types.js'

type SendMessageImpl = typeof sendMessage
type PollUpdatesImpl = typeof pollUpdates

export interface StartServiceInbound {
  peerId: string
  text: string
  contextToken: string
  dedupeKey?: string
}

export interface StartServiceOptions {
  stateDir: string
  loginState: SavedLoginState
  adapter: AgentAdapter
  logger?: RuntimeLogger
  fetchImpl?: FetchImpl
  sendMessageImpl?: SendMessageImpl
  pollUpdatesImpl?: PollUpdatesImpl
  sleep?: (ms: number) => Promise<void>
  pollErrorBackoffMs?: number
}

export interface StartService {
  handleInbound(input: StartServiceInbound): Promise<void>
  pollOnce(): Promise<void>
  start(): Promise<void>
  debugState(): { peers: string[] }
}

function formatAgentFailureNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (/timed out/i.test(message)) {
    return '处理这条消息时超时了，请稍后重试。'
  }

  if (/spawn|enoent|failed to start/i.test(message)) {
    return '本地代理启动失败，请确认本地环境已安装并配置正确后重试。'
  }

  if (/without an agent message|no response/i.test(message)) {
    return '这次没有收到代理返回内容，请稍后重试。'
  }

  return '处理这条消息失败了，请稍后重试。'
}

function isRetryablePollError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const cause = (
    error as Error & {
      cause?: {
        code?: unknown
      }
    }
  ).cause
  const code = typeof cause?.code === 'string' ? cause.code : null
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true
  }

  if (/fetch failed/i.test(error.message)) {
    return true
  }

  if (/request failed with status 5\d\d/i.test(error.message)) {
    return true
  }

  return false
}

function extractInboundText(message: { content?: string; item_list?: unknown }): string | null {
  if (typeof message.content === 'string' && message.content.length > 0) {
    return message.content
  }

  if (!Array.isArray(message.item_list)) {
    return null
  }

  for (const item of message.item_list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }

    const candidate = item as {
      type?: unknown
      text_item?: { text?: unknown }
    }
    if (candidate.type !== 1) {
      continue
    }

    if (typeof candidate.text_item?.text === 'string' && candidate.text_item.text.length > 0) {
      return candidate.text_item.text
    }
  }

  return null
}

function extractInboundTextMessage(message: {
  from_user_id?: string
  context_token?: string
  content?: string
  item_list?: unknown
}): { peerId: string; contextToken: string; text: string } | null {
  if (typeof message.from_user_id !== 'string' || typeof message.context_token !== 'string') {
    return null
  }

  const text = extractInboundText(message)
  if (!text) {
    return null
  }

  return {
    peerId: message.from_user_id,
    contextToken: message.context_token,
    text,
  }
}

function extractInboundDedupeKey(
  message: Record<string, unknown> & {
    from_user_id: string
    context_token: string
    content?: string
  }
): string | undefined {
  const rawId = message.message_id ?? message.msg_id ?? message.msgid ?? message.id
  if (typeof rawId === 'string' || typeof rawId === 'number') {
    return String(rawId)
  }

  return undefined
}

export function createStartService(input: StartServiceOptions): StartService {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const sendMessageImpl = input.sendMessageImpl ?? sendMessage
  const pollUpdatesImpl = input.pollUpdatesImpl ?? pollUpdates
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollErrorBackoffMs = input.pollErrorBackoffMs ?? 1_000
  const logger = input.logger
  const peers = new Set<string>()
  let pendingRecovery: Promise<void> | null = null
  let fatalError: unknown = null

  function deriveDedupeKey(message: {
    peerId: string
    contextToken: string
    text: string
    dedupeKey?: string
  }): string | undefined {
    if (typeof message.dedupeKey === 'string' && message.dedupeKey.length > 0) {
      return message.dedupeKey
    }

    return undefined
  }

  async function recoverPendingInbounds(): Promise<void> {
    const pendingInbounds = await readPendingInbounds(input.stateDir)
    for (const pendingInbound of pendingInbounds) {
      const routed = routeInboundText(pendingInbound.text)
      logger?.info('pending.recovered', {
        peerId: pendingInbound.peerId,
        dedupeKey: pendingInbound.dedupeKey,
        kind: routed.kind,
        textLength: pendingInbound.text.length,
      })
      peers.add(pendingInbound.peerId)
      sessionManager.acceptInbound({
        peerId: pendingInbound.peerId,
        kind: routed.kind,
        text: routed.text,
        completionRefs: [pendingInbound.dedupeKey],
      })
    }
  }

  async function ensureRecoveredPendingInbounds(): Promise<void> {
    if (!pendingRecovery) {
      pendingRecovery = recoverPendingInbounds()
    }

    await pendingRecovery
  }

  function throwIfFatalError(): void {
    if (!fatalError) {
      return
    }

    if (fatalError instanceof Error) {
      throw fatalError
    }

    const message =
      typeof fatalError === 'string'
        ? fatalError
        : typeof fatalError === 'number'
          ? String(fatalError)
          : 'An unknown error occurred'
    throw new Error(message)
  }

  const sessionManager = new SessionManager({
    adapter: input.adapter,
    logger,
    onTurnComplete: async (event) => {
      await completeInboundMessages(input.stateDir, event.completionRefs)
    },
    onTurnReply: async (event) => {
      const contextToken = await readPeerContextToken(input.stateDir, event.peerId)
      if (!contextToken) {
        logger?.warn('wechat.send.skipped', {
          peerId: event.peerId,
          reason: 'missing_context_token',
        })
        return
      }

      const replyText =
        event.status === 'unsupported_command' && event.text.trim().length === 0
          ? '当前 agent 不支持这个命令。'
          : event.text

      logger?.info('wechat.send.started', {
        peerId: event.peerId,
        kind: event.kind,
        status: event.status,
        reason: 'agent_reply',
        textLength: replyText.length,
      })

      try {
        await sendMessageImpl({
          baseUrl: input.loginState.baseUrl,
          token: input.loginState.botToken,
          botAccountId: input.loginState.botAccountId,
          peerId: event.peerId,
          contextToken,
          text: replyText,
          fetchImpl,
        })
      } catch (error) {
        logger?.warn('wechat.send.failed', {
          peerId: event.peerId,
          kind: event.kind,
          status: event.status,
          reason: 'agent_reply',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      logger?.info('wechat.send.succeeded', {
        peerId: event.peerId,
        kind: event.kind,
        status: event.status,
        reason: 'agent_reply',
      })
    },
    onTurnFailure: async (event) => {
      await completeInboundMessages(input.stateDir, event.completionRefs)

      const contextToken = await readPeerContextToken(input.stateDir, event.peerId)
      if (!contextToken) {
        logger?.warn('wechat.send.skipped', {
          peerId: event.peerId,
          reason: 'missing_context_token_after_failure',
        })
        return
      }

      const failureText = formatAgentFailureNotice(event.error)
      logger?.info('wechat.send.started', {
        peerId: event.peerId,
        kind: event.kind,
        reason: 'agent_failure_notice',
        textLength: failureText.length,
      })

      try {
        await sendMessageImpl({
          baseUrl: input.loginState.baseUrl,
          token: input.loginState.botToken,
          botAccountId: input.loginState.botAccountId,
          peerId: event.peerId,
          contextToken,
          text: failureText,
          fetchImpl,
        })
      } catch (error) {
        logger?.warn('wechat.send.failed', {
          peerId: event.peerId,
          kind: event.kind,
          reason: 'agent_failure_notice',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      logger?.info('wechat.send.succeeded', {
        peerId: event.peerId,
        kind: event.kind,
        reason: 'agent_failure_notice',
      })
    },
    onSessionError: (event) => {
      if (!fatalError) {
        fatalError = event.error
      }
      logger?.error('session.fatal', {
        peerId: event.peerId,
        error: event.error instanceof Error ? event.error.message : String(event.error),
      })
    },
  })

  async function handleInbound(message: StartServiceInbound): Promise<void> {
    throwIfFatalError()
    await ensureRecoveredPendingInbounds()
    throwIfFatalError()

    const dedupeKey = deriveDedupeKey(message)
    const recorded = await recordInboundMessage(input.stateDir, {
      peerId: message.peerId,
      text: message.text,
      contextToken: message.contextToken,
      dedupeKey,
    })
    if (recorded.status !== 'new') {
      logger?.info('inbound.duplicate', {
        peerId: message.peerId,
        dedupeKey: dedupeKey ?? '',
      })
      return
    }

    logger?.info('inbound.accepted', {
      peerId: message.peerId,
      dedupeKey: dedupeKey ?? '',
      kind: routeInboundText(message.text).kind,
      commandName: extractNativeCommandName(message.text),
      textLength: message.text.length,
    })
    peers.add(message.peerId)

    const routed = routeInboundText(message.text)
    const accepted = sessionManager.acceptInbound({
      peerId: message.peerId,
      kind: routed.kind,
      text: routed.text,
      completionRefs: recorded.completionRefs,
    })

    if (!accepted.followUpAck) {
      return
    }

    logger?.info('inbound.queued', {
      peerId: message.peerId,
      kind: routed.kind,
      commandName: extractNativeCommandName(message.text),
      textLength: message.text.length,
    })

    logger?.info('wechat.send.started', {
      peerId: message.peerId,
      reason: 'follow_up_ack',
      textLength: accepted.followUpAck.length,
    })
    try {
      await sendMessageImpl({
        baseUrl: input.loginState.baseUrl,
        token: input.loginState.botToken,
        botAccountId: input.loginState.botAccountId,
        peerId: message.peerId,
        contextToken: message.contextToken,
        text: accepted.followUpAck,
        fetchImpl,
      })
      logger?.info('wechat.send.succeeded', {
        peerId: message.peerId,
        reason: 'follow_up_ack',
      })
    } catch (error) {
      logger?.warn('wechat.send.failed', {
        peerId: message.peerId,
        reason: 'follow_up_ack',
        error: error instanceof Error ? error.message : String(error),
      })
      // Follow-up acks are best-effort and must not replay an already queued turn.
    }
  }

  async function pollOnce(): Promise<void> {
    throwIfFatalError()
    await ensureRecoveredPendingInbounds()
    throwIfFatalError()

    await pollUpdatesImpl({
      stateDir: input.stateDir,
      baseUrl: input.loginState.baseUrl,
      token: input.loginState.botToken,
      botAccountId: input.loginState.botAccountId,
      fetchImpl,
      onBatch: async (response) => {
        for (const message of response.msgs) {
          const inbound = extractInboundTextMessage(message)
          if (!inbound) {
            continue
          }

          await handleInbound({
            peerId: inbound.peerId,
            text: inbound.text,
            contextToken: inbound.contextToken,
            dedupeKey: extractInboundDedupeKey(
              message as Record<string, unknown> & {
                from_user_id: string
                context_token: string
                content?: string
              }
            ),
          })
        }
        return undefined
      },
    })
  }

  async function start(): Promise<void> {
    throwIfFatalError()
    await ensureRecoveredPendingInbounds()
    throwIfFatalError()

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      throwIfFatalError()
      try {
        await pollOnce()
      } catch (error) {
        if (!isRetryablePollError(error)) {
          throw error
        }

        logger?.warn('poll.retrying', {
          error: error instanceof Error ? error.message : String(error),
          backoffMs: pollErrorBackoffMs,
        })
        await sleep(pollErrorBackoffMs)
      }
    }
  }

  return {
    handleInbound,
    pollOnce,
    start,
    debugState() {
      return {
        peers: Array.from(peers),
      }
    },
  }
}

export async function createConfiguredStartService(input: {
  stateDir: string
  adapter: AgentAdapter
  logger?: RuntimeLogger
  fetchImpl?: FetchImpl
  sendMessageImpl?: SendMessageImpl
  pollUpdatesImpl?: PollUpdatesImpl
  sleep?: (ms: number) => Promise<void>
  pollErrorBackoffMs?: number
}): Promise<StartService> {
  const loginState = await readLoginState(input.stateDir)
  if (!loginState) {
    throw new Error('WeChat login state is missing; run login first')
  }

  return createStartService({
    stateDir: input.stateDir,
    loginState,
    adapter: input.adapter,
    logger: input.logger,
    fetchImpl: input.fetchImpl,
    sendMessageImpl: input.sendMessageImpl,
    pollUpdatesImpl: input.pollUpdatesImpl,
    sleep: input.sleep,
    pollErrorBackoffMs: input.pollErrorBackoffMs,
  })
}
