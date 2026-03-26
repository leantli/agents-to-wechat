import type { AgentAdapter } from '../agents/types.js'
import { PeerSession } from './peer-session.js'
import type { AcceptInboundResult, InboundPeerMessage, SessionManagerOptions } from './types.js'

export class SessionManager {
  private readonly peerSessions = new Map<string, PeerSession>()

  constructor(private readonly options: SessionManagerOptions) {}

  acceptInbound(input: InboundPeerMessage): AcceptInboundResult {
    return this.getPeerSession(input.peerId).acceptInbound(input)
  }

  peekPending(peerId: string): string | null {
    return this.peerSessions.get(peerId)?.peekPending() ?? null
  }

  snapshot(peerId: string) {
    return this.peerSessions.get(peerId)?.snapshot() ?? null
  }

  private getPeerSession(peerId: string): PeerSession {
    const existing = this.peerSessions.get(peerId)
    if (existing) {
      return existing
    }

    const session = new PeerSession(
      peerId,
      this.options.adapter satisfies AgentAdapter,
      this.options.followUpAckMessage,
      this.options.onTurnComplete,
      this.options.onTurnReply,
      this.options.onTurnFailure,
      this.options.onSessionError,
      this.options.logger
    )

    this.peerSessions.set(peerId, session)
    return session
  }
}
