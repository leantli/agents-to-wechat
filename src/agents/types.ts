export type AgentTurnKind = 'prompt' | 'native_command'

export interface AgentSession {
  sessionId: string
}

export interface AgentInboundTurn {
  kind: AgentTurnKind
  text: string
}

export interface AgentNativeCommandCompletedResult {
  status: 'completed'
  text: string
  logContext?: AgentCommandLogContext
}

export interface AgentUnsupportedCommandResult {
  status: 'unsupported_command'
  text: string
  logContext?: AgentCommandLogContext
}

export interface AgentCommandLogContext {
  commandName?: string
  commandAction?: string
  requestedModel?: string
  resolvedModel?: string
  currentModelId?: string
}

export type AgentNativeCommandResult =
  | AgentNativeCommandCompletedResult
  | AgentUnsupportedCommandResult

export interface AgentAdapter {
  createSession(peerId: string): string | Promise<string>
  resetSession?(peerId: string): void | Promise<void>
  sendPrompt?(sessionId: string, input: string): Promise<string>
  executeNativeCommand?(sessionId: string, input: string): Promise<AgentNativeCommandResult>
}

export interface AgentTurnRecord {
  peerId: string
  sessionId: string
  input: string
  kind?: AgentTurnKind
}
