import type { AgentAdapter, AgentNativeCommandResult, AgentTurnKind } from '../agents/types.js'
import type { RuntimeLogger } from '../logging/runtime-logger.js'

export interface SessionManagerOptions {
  adapter: AgentAdapter
  followUpAckMessage?: string
  onTurnComplete?: (event: CompletedPeerTurn) => void | Promise<void>
  onTurnReply?: (event: CompletedPeerTurn) => void | Promise<void>
  onTurnFailure?: (event: FailedPeerTurn) => void | Promise<void>
  onSessionError?: (event: SessionErrorEvent) => void | Promise<void>
  logger?: RuntimeLogger
}

export interface InboundPeerMessage {
  peerId: string
  kind?: AgentTurnKind
  text: string
  completionRefs?: string[]
}

export interface AcceptInboundResult {
  started: boolean
  followUpAck: string | null
}

export interface PeerSessionSnapshot {
  peerId: string
  active: boolean
  pendingText: string | null
  pendingKind: AgentTurnKind | null
}

export interface CompletedPeerTurn {
  peerId: string
  kind: AgentTurnKind
  status: AgentNativeCommandResult['status']
  text: string
  completionRefs: string[]
}

export interface FailedPeerTurn {
  peerId: string
  kind: AgentTurnKind
  input: string
  completionRefs: string[]
  error: unknown
}

export interface SessionErrorEvent {
  peerId: string
  error: unknown
}

export const DEFAULT_FOLLOW_UP_ACK = '上一条回复仍在处理中，我已经收到你的补充，稍后继续处理。'
