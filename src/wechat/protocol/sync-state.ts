import { readJson, writeJson } from '../../storage/json-store.js'
import { getStatePath } from '../../storage/paths.js'

export interface SyncState {
  getUpdatesBuf: string
  peerContextTokens: Record<string, string>
  handledInboundIds: string[]
  pendingInbounds: PendingInboundRecord[]
}

export type SyncStateUpdater = (current: SyncState) => SyncState | Promise<SyncState>

export interface PendingInboundRecord {
  dedupeKey: string
  peerId: string
  text: string
  contextToken: string
}

export interface RecordInboundMessageInput {
  peerId: string
  text: string
  contextToken: string
  dedupeKey?: string | null
}

export interface RecordInboundMessageResult {
  status: 'new' | 'pending' | 'completed'
  completionRefs: string[]
  state: SyncState
}

const SYNC_STATE_FILE = 'wechat-sync.json'
const DEFAULT_MAX_HANDLED_INBOUND_IDS = 1_024

class Mutex {
  private tail: Promise<void> = Promise.resolve()

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })

    return previous
      .catch(() => undefined)
      .then(async () => {
        try {
          return await task()
        } finally {
          release()
        }
      })
  }
}

const stateMutexes = new Map<string, Mutex>()

function normalizeSyncState(state: Partial<SyncState> | null): SyncState {
  return {
    getUpdatesBuf: state?.getUpdatesBuf ?? '',
    peerContextTokens: state?.peerContextTokens ?? {},
    handledInboundIds: Array.isArray(state?.handledInboundIds)
      ? state.handledInboundIds.filter((value): value is string => typeof value === 'string')
      : [],
    pendingInbounds: Array.isArray(state?.pendingInbounds)
      ? state.pendingInbounds.filter((value): value is PendingInboundRecord => {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (value === null || typeof value !== 'object') {
            return false
          }
          return (
            typeof value.dedupeKey === 'string' &&
            typeof value.peerId === 'string' &&
            typeof value.text === 'string' &&
            typeof value.contextToken === 'string'
          )
        })
      : [],
  }
}

export function createEmptySyncState(): SyncState {
  return normalizeSyncState(null)
}

function getSyncStatePath(stateDir: string): string {
  return getStatePath(stateDir, SYNC_STATE_FILE)
}

function getStateMutex(stateDir: string): Mutex {
  const statePath = getSyncStatePath(stateDir)
  let mutex = stateMutexes.get(statePath)
  if (!mutex) {
    mutex = new Mutex()
    stateMutexes.set(statePath, mutex)
  }

  return mutex
}

function mergeSyncState(current: Partial<SyncState> | null, patch: Partial<SyncState>): SyncState {
  return {
    getUpdatesBuf: patch.getUpdatesBuf ?? current?.getUpdatesBuf ?? '',
    peerContextTokens: {
      ...(current?.peerContextTokens ?? {}),
      ...(patch.peerContextTokens ?? {}),
    },
    handledInboundIds: patch.handledInboundIds ?? current?.handledInboundIds ?? [],
    pendingInbounds: patch.pendingInbounds ?? current?.pendingInbounds ?? [],
  }
}

function appendHandledInboundId(
  handledInboundIds: string[],
  dedupeKey: string,
  maxHandledInboundIds: number
): string[] {
  if (handledInboundIds.includes(dedupeKey)) {
    return handledInboundIds
  }

  const nextIds = [...handledInboundIds, dedupeKey]
  if (nextIds.length <= maxHandledInboundIds) {
    return nextIds
  }

  return nextIds.slice(nextIds.length - maxHandledInboundIds)
}

function scopeInboundDedupeKey(peerId: string, dedupeKey: string): string {
  return `${peerId}\u0000${dedupeKey}`
}

export async function readSyncState(stateDir: string): Promise<SyncState | null> {
  return getStateMutex(stateDir).runExclusive(async () => {
    const state = await readJson<Partial<SyncState>>(getSyncStatePath(stateDir))
    return state ? normalizeSyncState(state) : null
  })
}

export async function updateSyncState(
  stateDir: string,
  updater: SyncStateUpdater
): Promise<SyncState> {
  return getStateMutex(stateDir).runExclusive(async () => {
    const current = normalizeSyncState(
      await readJson<Partial<SyncState>>(getSyncStatePath(stateDir))
    )
    const next = await updater(current)
    const normalized = normalizeSyncState(next)
    await writeJson(getSyncStatePath(stateDir), normalized)
    return normalized
  })
}

export async function writeSyncState(
  stateDir: string,
  patch: Partial<SyncState>
): Promise<SyncState> {
  return updateSyncState(stateDir, (current) => {
    return mergeSyncState(current, patch)
  })
}

export async function readGetUpdatesBuf(stateDir: string): Promise<string> {
  return (await readSyncState(stateDir))?.getUpdatesBuf ?? ''
}

export async function writeGetUpdatesBuf(
  stateDir: string,
  getUpdatesBuf: string
): Promise<SyncState> {
  return writeSyncState(stateDir, {
    getUpdatesBuf,
  })
}

export async function readPeerContextToken(
  stateDir: string,
  peerId: string
): Promise<string | null> {
  return (await readSyncState(stateDir))?.peerContextTokens[peerId] ?? null
}

export async function writePeerContextToken(
  stateDir: string,
  peerId: string,
  contextToken: string
): Promise<SyncState> {
  return writeSyncState(stateDir, {
    peerContextTokens: {
      [peerId]: contextToken,
    },
  })
}

export async function readPendingInbounds(stateDir: string): Promise<PendingInboundRecord[]> {
  return (await readSyncState(stateDir))?.pendingInbounds ?? []
}

export async function recordInboundMessage(
  stateDir: string,
  input: RecordInboundMessageInput
): Promise<RecordInboundMessageResult> {
  const rawDedupeKey =
    typeof input.dedupeKey === 'string' && input.dedupeKey.length > 0 ? input.dedupeKey : null
  const dedupeKey = rawDedupeKey ? scopeInboundDedupeKey(input.peerId, rawDedupeKey) : null
  let status: RecordInboundMessageResult['status'] = 'new'

  const state = await updateSyncState(stateDir, (current) => {
    if (dedupeKey && current.handledInboundIds.includes(dedupeKey)) {
      status = 'completed'
      return current
    }

    if (dedupeKey && current.pendingInbounds.some((record) => record.dedupeKey === dedupeKey)) {
      status = 'pending'
      return current
    }

    return {
      getUpdatesBuf: current.getUpdatesBuf,
      peerContextTokens: {
        ...current.peerContextTokens,
        [input.peerId]: input.contextToken,
      },
      handledInboundIds: current.handledInboundIds,
      pendingInbounds: dedupeKey
        ? [
            ...current.pendingInbounds,
            {
              dedupeKey,
              peerId: input.peerId,
              text: input.text,
              contextToken: input.contextToken,
            },
          ]
        : current.pendingInbounds,
    }
  })

  return {
    status,
    completionRefs: dedupeKey ? [dedupeKey] : [],
    state,
  }
}

export async function completeInboundMessages(
  stateDir: string,
  completionRefs: string[]
): Promise<SyncState> {
  const uniqueRefs = Array.from(
    new Set(
      completionRefs.filter(
        (completionRef): completionRef is string =>
          typeof completionRef === 'string' && completionRef.length > 0
      )
    )
  )
  if (uniqueRefs.length === 0) {
    return (await readSyncState(stateDir)) ?? createEmptySyncState()
  }

  return updateSyncState(stateDir, (current) => {
    let handledInboundIds = current.handledInboundIds
    for (const completionRef of uniqueRefs) {
      handledInboundIds = appendHandledInboundId(
        handledInboundIds,
        completionRef,
        DEFAULT_MAX_HANDLED_INBOUND_IDS
      )
    }

    return {
      getUpdatesBuf: current.getUpdatesBuf,
      peerContextTokens: current.peerContextTokens,
      handledInboundIds,
      pendingInbounds: current.pendingInbounds.filter(
        (record) => !uniqueRefs.includes(record.dedupeKey)
      ),
    }
  })
}
