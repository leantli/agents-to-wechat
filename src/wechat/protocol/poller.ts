import { getUpdates } from './messages.js'
import {
  createEmptySyncState,
  readSyncState,
  updateSyncState,
  type SyncState,
} from './sync-state.js'
import type { FetchImpl } from './types.js'

export interface PollOnceInput {
  stateDir: string
  baseUrl: string
  token: string
  botAccountId: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

export interface PollUpdatesInput extends PollOnceInput {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  backoffMs?: (attempt: number) => number
  onRetry?: (error: unknown, attempt: number) => void | Promise<void>
  onBatch?: (
    response: Awaited<ReturnType<typeof pollOnce>>
  ) => boolean | undefined | Promise<boolean | undefined>
}

function createSleep(): (ms: number) => Promise<void> {
  return (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

function createPollStatePatch(
  response: Awaited<ReturnType<typeof getUpdates>>
): Partial<SyncState> {
  const peerContextTokens: Record<string, string> = {}

  for (const message of response.msgs) {
    if (typeof message.from_user_id === 'string' && typeof message.context_token === 'string') {
      peerContextTokens[message.from_user_id] = message.context_token
    }
  }

  return {
    getUpdatesBuf: response.getUpdatesBuf,
    peerContextTokens,
  }
}

function mergePollPatch(input: {
  currentState: SyncState
  baseState: SyncState
  patch: Partial<SyncState>
}): SyncState {
  const nextState: SyncState = {
    getUpdatesBuf: input.currentState.getUpdatesBuf,
    peerContextTokens: {
      ...input.currentState.peerContextTokens,
    },
    handledInboundIds: [...input.currentState.handledInboundIds],
    pendingInbounds: [...input.currentState.pendingInbounds],
  }

  if (
    typeof input.patch.getUpdatesBuf === 'string' &&
    input.currentState.getUpdatesBuf === input.baseState.getUpdatesBuf
  ) {
    nextState.getUpdatesBuf = input.patch.getUpdatesBuf
  }

  for (const [peerId, contextToken] of Object.entries(input.patch.peerContextTokens ?? {})) {
    if (
      input.currentState.peerContextTokens[peerId] === input.baseState.peerContextTokens[peerId]
    ) {
      nextState.peerContextTokens[peerId] = contextToken
    }
  }

  return nextState
}

async function commitPollState(input: {
  stateDir: string
  baseState: SyncState
  response: Awaited<ReturnType<typeof getUpdates>>
}): Promise<SyncState> {
  const patch = createPollStatePatch(input.response)
  return updateSyncState(input.stateDir, (currentState) => {
    return mergePollPatch({
      currentState,
      baseState: input.baseState,
      patch,
    })
  })
}

async function getCurrentSyncState(stateDir: string): Promise<SyncState> {
  return (await readSyncState(stateDir)) ?? createEmptySyncState()
}

export async function pollOnce(input: PollOnceInput) {
  const timeoutMs = input.timeoutMs ?? 35_000
  const currentState = await getCurrentSyncState(input.stateDir)
  const response = await getUpdates({
    baseUrl: input.baseUrl,
    token: input.token,
    botAccountId: input.botAccountId,
    getUpdatesBuf: currentState.getUpdatesBuf,
    fetchImpl: input.fetchImpl,
    timeoutMs,
  })
  await commitPollState({
    stateDir: input.stateDir,
    baseState: currentState,
    response,
  })
  return response
}

export async function pollUpdates(input: PollUpdatesInput) {
  const sleep = input.sleep ?? createSleep()
  const timeoutMs = input.timeoutMs ?? 35_000
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  const backoffMs = input.backoffMs ?? ((attempt: number) => pollIntervalMs * attempt)
  const startTime = Date.now()
  let attempt = 0
  let lastResponse: Awaited<ReturnType<typeof pollOnce>> | null = null
  let lastError: unknown = null

  while (Date.now() - startTime < timeoutMs) {
    const remainingBeforeRequest = timeoutMs - (Date.now() - startTime)
    if (remainingBeforeRequest <= 0) {
      break
    }

    const currentState = await getCurrentSyncState(input.stateDir)
    const remainingRequestBudget = timeoutMs - (Date.now() - startTime)
    if (remainingRequestBudget <= 0) {
      break
    }

    let response: Awaited<ReturnType<typeof getUpdates>>
    try {
      response = await getUpdates({
        baseUrl: input.baseUrl,
        token: input.token,
        botAccountId: input.botAccountId,
        getUpdatesBuf: currentState.getUpdatesBuf,
        fetchImpl: input.fetchImpl,
        timeoutMs: remainingRequestBudget,
      })
    } catch (error) {
      lastError = error
      attempt += 1
      await input.onRetry?.(error, attempt)
      const remainingAfterFailure = timeoutMs - (Date.now() - startTime)
      if (remainingAfterFailure <= 0) {
        break
      }

      await sleep(Math.min(backoffMs(attempt), remainingAfterFailure))
      continue
    }

    const shouldContinue = await input.onBatch?.(response)
    await commitPollState({
      stateDir: input.stateDir,
      baseState: currentState,
      response,
    })

    lastResponse = response
    lastError = null
    attempt = 0

    if (shouldContinue === false) {
      break
    }

    const remainingMs = timeoutMs - (Date.now() - startTime)
    if (remainingMs <= 0) {
      break
    }

    await sleep(Math.min(backoffMs(1), remainingMs))
  }

  if (lastError) {
    if (lastError instanceof Error) {
      throw lastError
    }

    const message =
      typeof lastError === 'string'
        ? lastError
        : typeof lastError === 'number'
          ? String(lastError)
          : 'An unknown error occurred'
    throw new Error(message)
  }

  if (lastResponse) {
    return lastResponse
  }

  throw new Error('Timed out waiting for WeChat updates')
}
