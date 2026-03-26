import type {
  AgentAdapter,
  AgentNativeCommandResult,
  AgentTurnKind,
  AgentTurnRecord,
} from './types.js'

interface PendingTurn {
  peerId: string
  sessionId: string
  kind: AgentTurnKind
  resolve: (value: string | AgentNativeCommandResult) => void
  reject: (error: unknown) => void
}

export class MockAdapter implements AgentAdapter {
  public readonly turns: AgentTurnRecord[] = []

  private readonly peerSessions = new Map<string, string>()
  private readonly sessionPeers = new Map<string, string>()
  private readonly pendingTurns = new Map<string, PendingTurn[]>()

  createSession(peerId: string): string {
    const existing = this.peerSessions.get(peerId)
    if (existing) {
      return existing
    }

    const sessionId = `session-${peerId}`
    this.peerSessions.set(peerId, sessionId)
    this.sessionPeers.set(sessionId, peerId)
    return sessionId
  }

  async sendPrompt(sessionId: string, input: string): Promise<string> {
    const peerId = this.sessionPeers.get(sessionId)
    if (!peerId) {
      throw new Error(`Unknown mock session: ${sessionId}`)
    }

    this.turns.push({
      peerId,
      sessionId,
      input,
      kind: 'prompt',
    })

    return await new Promise<string>((resolve, reject) => {
      this.enqueuePendingTurn(
        peerId,
        sessionId,
        'prompt',
        (value) => {
          resolve(value as string)
        },
        reject
      )
    })
  }

  async executeNativeCommand(sessionId: string, input: string): Promise<AgentNativeCommandResult> {
    const peerId = this.sessionPeers.get(sessionId)
    if (!peerId) {
      throw new Error(`Unknown mock session: ${sessionId}`)
    }

    this.turns.push({
      peerId,
      sessionId,
      input,
      kind: 'native_command',
    })

    return await new Promise<AgentNativeCommandResult>((resolve, reject) => {
      this.enqueuePendingTurn(
        peerId,
        sessionId,
        'native_command',
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
    status: AgentNativeCommandResult['status'] = 'completed'
  ): void {
    const queue = this.pendingTurns.get(peerId)
    const next = queue?.shift()
    if (!next) {
      throw new Error(`No pending mock turn for peer ${peerId}`)
    }

    if (next.kind === 'prompt') {
      next.resolve(value)
    } else {
      next.resolve({
        status,
        text: value,
      })
    }

    if (queue && queue.length === 0) {
      this.pendingTurns.delete(peerId)
    }
  }

  rejectNextTurn(peerId: string, error: unknown): void {
    const queue = this.pendingTurns.get(peerId)
    const next = queue?.shift()
    if (!next) {
      throw new Error(`No pending mock turn for peer ${peerId}`)
    }

    next.reject(error)
    if (queue && queue.length === 0) {
      this.pendingTurns.delete(peerId)
    }
  }

  private enqueuePendingTurn(
    peerId: string,
    sessionId: string,
    kind: AgentTurnKind,
    resolve: (value: string | AgentNativeCommandResult) => void,
    reject: (error: unknown) => void
  ): void {
    const queue = this.pendingTurns.get(peerId) ?? []
    queue.push({
      peerId,
      sessionId,
      kind,
      resolve,
      reject,
    })
    this.pendingTurns.set(peerId, queue)
  }
}
