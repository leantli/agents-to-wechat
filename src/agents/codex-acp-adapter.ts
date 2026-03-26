import { createAcpTransport, type AcpTransport } from './acp-transport.js'
import type { AcpEventMessage } from './acp-protocol.js'
import { extractNativeCommandName } from './native-command.js'
import type { AgentAdapter, AgentCommandLogContext, AgentNativeCommandResult } from './types.js'

interface CodexAcpAdapterOptions {
  cwd: string
  command?: string
  args?: string[]
  turnTimeoutMs?: number
  clientInfo?: {
    name: string
    version: string
  }
  mcpServers?: unknown[]
  transportFactory?: (options: { onEvent: (event: AcpEventMessage) => void }) => AcpTransport
}

interface CodexAcpSession {
  peerId: string
  sessionId: string
  availableCommands: Set<string> | null
  modelState: SessionModelState
  pendingTurn: PendingTurn | null
}

interface PendingTurn {
  chunks: string[]
  touchActivity: () => void
  clearActivityTimeout: () => void
}

interface SessionModel {
  modelId: string
  name?: string
}

interface SessionModelState {
  currentModelId: string | null
  availableModels: SessionModel[]
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const MAX_IGNORED_SESSION_IDS = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractSessionId(result: unknown): string {
  if (!isRecord(result) || typeof result.sessionId !== 'string') {
    throw new Error('ACP session/new response did not include a sessionId')
  }

  return result.sessionId
}

function extractModelState(result: unknown): SessionModelState {
  if (!isRecord(result) || !isRecord(result.models)) {
    return {
      currentModelId: null,
      availableModels: [],
    }
  }

  const currentModelId =
    typeof result.models.currentModelId === 'string' ? result.models.currentModelId : null
  const availableModels = Array.isArray(result.models.availableModels)
    ? result.models.availableModels.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.modelId !== 'string') {
          return []
        }

        return [
          {
            modelId: entry.modelId,
            name: typeof entry.name === 'string' ? entry.name : undefined,
          } satisfies SessionModel,
        ]
      })
    : []

  return {
    currentModelId,
    availableModels,
  }
}

function extractSessionUpdateEvent(event: AcpEventMessage): {
  sessionId: string
  update: Record<string, unknown>
} | null {
  if (!isRecord(event) || event.method !== 'session/update') {
    return null
  }

  const params = event.params
  if (!isRecord(params) || typeof params.sessionId !== 'string' || !isRecord(params.update)) {
    return null
  }

  return {
    sessionId: params.sessionId,
    update: params.update,
  }
}

function extractAvailableCommandNames(update: Record<string, unknown>): Set<string> | null {
  if (
    update.sessionUpdate !== 'available_commands_update' ||
    !Array.isArray(update.availableCommands)
  ) {
    return null
  }

  const commands = new Set<string>()
  for (const entry of update.availableCommands) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      continue
    }

    commands.add(entry.name)
  }

  return commands
}

function extractAgentMessageChunk(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== 'agent_message_chunk') {
    return null
  }

  const content = update.content
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
    return null
  }

  return content.text
}

function parseModelCommand(input: string): { target: string | null } | null {
  const trimmed = input.trim()
  if (extractNativeCommandName(trimmed) !== '/model') {
    return null
  }

  const suffix = trimmed.slice('/model'.length).trim()
  return {
    target: suffix.length > 0 ? suffix : null,
  }
}

function formatModelSummary(state: SessionModelState): string {
  const lines = [`当前模型：${state.currentModelId ?? '未知'}`, '可用模型：']

  for (const model of state.availableModels) {
    lines.push(`- ${model.modelId}`)
  }

  return lines.join('\n')
}

function normalizeModelTarget(input: string): string {
  return input.trim().replace(/\s+/, '/')
}

function resolveModelTarget(state: SessionModelState, input: string): string | null {
  const normalized = normalizeModelTarget(input)
  const availableModelIds = new Set(state.availableModels.map((model) => model.modelId))
  if (availableModelIds.has(normalized)) {
    return normalized
  }

  if (!normalized.includes('/')) {
    const currentEffort = state.currentModelId?.split('/')[1]
    if (currentEffort) {
      const withCurrentEffort = `${normalized}/${currentEffort}`
      if (availableModelIds.has(withCurrentEffort)) {
        return withCurrentEffort
      }
    }
  }

  return null
}

function createNativeCommandLogContext(input: string): AgentCommandLogContext | undefined {
  const commandName = extractNativeCommandName(input)
  if (!commandName) {
    return undefined
  }

  return {
    commandName,
  }
}

export class CodexAcpAdapter implements AgentAdapter {
  private readonly transport: AcpTransport
  private readonly clientInfo: { name: string; version: string }
  private readonly peerSessions = new Map<string, string>()
  private readonly pendingPeerSessions = new Map<string, Promise<string>>()
  private readonly sessions = new Map<string, CodexAcpSession>()
  private readonly pendingSessionUpdates = new Map<string, Record<string, unknown>[]>()
  private readonly ignoredSessionIds = new Set<string>()
  private initializePromise: Promise<void> | null = null
  private nextRequestId = 1

  constructor(private readonly options: CodexAcpAdapterOptions) {
    const transportFactory =
      options.transportFactory ??
      ((transportOptions) =>
        createAcpTransport({
          command: options.command,
          args: options.args,
          onEvent: transportOptions.onEvent,
        }))

    this.transport = transportFactory({
      onEvent: (event) => {
        this.onEvent(event)
      },
    })
    this.clientInfo = options.clientInfo ?? {
      name: 'agents-to-wechat',
      version: '0.0.0',
    }
  }

  async createSession(peerId: string): Promise<string> {
    const existing = this.peerSessions.get(peerId)
    if (existing) {
      return existing
    }

    const pending = this.pendingPeerSessions.get(peerId)
    if (pending) {
      return await pending
    }

    const createPromise = this.createSessionInternal(peerId)
    this.pendingPeerSessions.set(peerId, createPromise)

    try {
      return await createPromise
    } finally {
      if (this.pendingPeerSessions.get(peerId) === createPromise) {
        this.pendingPeerSessions.delete(peerId)
      }
    }
  }

  resetSession(peerId: string): void {
    const sessionId = this.peerSessions.get(peerId)
    if (!sessionId) {
      return
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      this.peerSessions.delete(peerId)
      this.pendingSessionUpdates.delete(sessionId)
      this.rememberIgnoredSessionId(sessionId)
      return
    }

    this.discardSession(session)
  }

  async sendPrompt(sessionId: string, input: string): Promise<string> {
    const session = this.getSession(sessionId)
    return await this.runPromptTurn(session, input)
  }

  async executeNativeCommand(sessionId: string, input: string): Promise<AgentNativeCommandResult> {
    const session = this.getSession(sessionId)
    const modelCommand = parseModelCommand(input)
    if (modelCommand) {
      return await this.handleModelCommand(session, modelCommand.target)
    }

    return {
      status: 'completed',
      text: await this.runPromptTurn(session, input),
      logContext: createNativeCommandLogContext(input),
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    const initializePromise = this.transport
      .request({
        id: this.allocateRequestId(),
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: this.clientInfo,
        },
      })
      .then(() => undefined)

    this.initializePromise = initializePromise

    try {
      await initializePromise
    } catch (error) {
      this.initializePromise = null
      throw error
    }
  }

  private async createSessionInternal(peerId: string): Promise<string> {
    await this.ensureInitialized()

    const sessionResult = await this.transport.request({
      id: this.allocateRequestId(),
      method: 'session/new',
      params: {
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers ?? [],
      },
    })
    const sessionId = extractSessionId(sessionResult)

    this.peerSessions.set(peerId, sessionId)
    this.sessions.set(sessionId, {
      peerId,
      sessionId,
      availableCommands: null,
      modelState: extractModelState(sessionResult),
      pendingTurn: null,
    })
    this.replayPendingSessionUpdates(sessionId)
    return sessionId
  }

  private getSession(sessionId: string): CodexAcpSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown ACP session: ${sessionId}`)
    }

    return session
  }

  private async runPromptTurn(session: CodexAcpSession, input: string): Promise<string> {
    if (session.pendingTurn) {
      throw new Error(`ACP session already has an active turn: ${session.sessionId}`)
    }

    const timeoutMs = this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    let rejectOnIdle: ((error: Error) => void) | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const abortController = new AbortController()
    const touchActivity = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      timeoutHandle = setTimeout(() => {
        this.discardSession(session)
        rejectOnIdle?.(
          new Error(`ACP turn timed out after ${String(timeoutMs)}ms without activity`)
        )
        abortController.abort()
      }, timeoutMs)
    }
    const clearActivityTimeout = () => {
      if (!timeoutHandle) {
        return
      }

      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    const inactivityGuard = new Promise<never>((_resolve, reject) => {
      rejectOnIdle = reject
    })
    const pendingTurn: PendingTurn = {
      chunks: [],
      touchActivity,
      clearActivityTimeout,
    }
    session.pendingTurn = pendingTurn
    pendingTurn.touchActivity()

    try {
      await Promise.race([
        this.transport.request(
          {
            id: this.allocateRequestId(),
            method: 'session/prompt',
            params: {
              sessionId: session.sessionId,
              prompt: [
                {
                  type: 'text',
                  text: input,
                },
              ],
            },
          },
          {
            signal: abortController.signal,
          }
        ),
        inactivityGuard,
      ])
      return pendingTurn.chunks.join('')
    } finally {
      pendingTurn.clearActivityTimeout()
      if (session.pendingTurn === pendingTurn) {
        session.pendingTurn = null
      }
    }
  }

  private onEvent(event: AcpEventMessage): void {
    const sessionUpdate = extractSessionUpdateEvent(event)
    if (!sessionUpdate) {
      return
    }

    if (this.ignoredSessionIds.has(sessionUpdate.sessionId)) {
      return
    }

    const session = this.sessions.get(sessionUpdate.sessionId)
    if (!session) {
      const queued = this.pendingSessionUpdates.get(sessionUpdate.sessionId) ?? []
      queued.push(sessionUpdate.update)
      this.pendingSessionUpdates.set(sessionUpdate.sessionId, queued)
      return
    }

    this.applySessionUpdate(session, sessionUpdate.update)
  }

  private replayPendingSessionUpdates(sessionId: string): void {
    const queued = this.pendingSessionUpdates.get(sessionId)
    if (!queued || queued.length === 0) {
      return
    }

    this.pendingSessionUpdates.delete(sessionId)

    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    for (const update of queued) {
      this.applySessionUpdate(session, update)
    }
  }

  private applySessionUpdate(session: CodexAcpSession, update: Record<string, unknown>): void {
    session.pendingTurn?.touchActivity()

    const availableCommands = extractAvailableCommandNames(update)
    if (availableCommands) {
      session.availableCommands = availableCommands
      return
    }

    const chunk = extractAgentMessageChunk(update)
    if (chunk === null || !session.pendingTurn) {
      return
    }

    session.pendingTurn.chunks.push(chunk)
  }

  private allocateRequestId(): string {
    const requestId = `acp-${String(this.nextRequestId)}`
    this.nextRequestId += 1
    return requestId
  }

  private async handleModelCommand(
    session: CodexAcpSession,
    target: string | null
  ): Promise<AgentNativeCommandResult> {
    if (!target || target === 'list') {
      return {
        status: 'completed',
        text: formatModelSummary(session.modelState),
        logContext: {
          commandAction: 'inspect_model',
          commandName: '/model',
          currentModelId: session.modelState.currentModelId ?? undefined,
        },
      }
    }

    const resolvedTarget = resolveModelTarget(session.modelState, target)
    if (!resolvedTarget) {
      return {
        status: 'completed',
        text: `未找到模型：${target}\n${formatModelSummary(session.modelState)}`,
        logContext: {
          commandAction: 'set_model',
          commandName: '/model',
          currentModelId: session.modelState.currentModelId ?? undefined,
          requestedModel: target,
        },
      }
    }

    await this.transport.request({
      id: this.allocateRequestId(),
      method: 'session/set_model',
      params: {
        sessionId: session.sessionId,
        modelId: resolvedTarget,
      },
    })

    session.modelState.currentModelId = resolvedTarget

    return {
      status: 'completed',
      text: `已切换到模型：${resolvedTarget}`,
      logContext: {
        commandAction: 'set_model',
        commandName: '/model',
        currentModelId: resolvedTarget,
        requestedModel: target,
        resolvedModel: resolvedTarget,
      },
    }
  }

  private discardSession(session: CodexAcpSession): void {
    this.peerSessions.delete(session.peerId)
    this.sessions.delete(session.sessionId)
    this.pendingSessionUpdates.delete(session.sessionId)
    this.rememberIgnoredSessionId(session.sessionId)
  }

  private rememberIgnoredSessionId(sessionId: string): void {
    if (this.ignoredSessionIds.has(sessionId)) {
      this.ignoredSessionIds.delete(sessionId)
    }

    this.ignoredSessionIds.add(sessionId)

    while (this.ignoredSessionIds.size > MAX_IGNORED_SESSION_IDS) {
      const oldest = this.ignoredSessionIds.values().next().value
      if (!oldest) {
        return
      }

      this.ignoredSessionIds.delete(oldest)
    }
  }
}
