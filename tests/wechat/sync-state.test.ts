import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  completeInboundMessages,
  recordInboundMessage,
  readSyncState,
  updateSyncState,
  writeSyncState,
} from '../../src/wechat/protocol/sync-state.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('wechat sync state', () => {
  it('waits for an in-process write to finish before reading', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    await writeSyncState(tempDir, {
      getUpdatesBuf: 'prev-buf',
      peerContextTokens: {
        'peer-1': 'ctx-1',
      },
    })

    let enteredWrite = false
    let signalWriteEntered!: () => void
    let releaseWrite!: () => void
    const writeEntered = new Promise<void>((resolve) => {
      signalWriteEntered = resolve
    })
    const waitForRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    const holdingWrite = updateSyncState(tempDir, async (current) => {
      enteredWrite = true
      signalWriteEntered()
      await waitForRelease

      return {
        getUpdatesBuf: 'next-buf',
        peerContextTokens: {
          ...current.peerContextTokens,
          'peer-2': 'ctx-2',
        },
        handledInboundIds: current.handledInboundIds,
        pendingInbounds: current.pendingInbounds,
      }
    })

    await writeEntered
    expect(enteredWrite).toBe(true)

    let settled = false
    const readPromise = readSyncState(tempDir).then((state) => {
      settled = true
      return state
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    releaseWrite()
    await holdingWrite

    await expect(readPromise).resolves.toEqual({
      getUpdatesBuf: 'next-buf',
      peerContextTokens: {
        'peer-1': 'ctx-1',
        'peer-2': 'ctx-2',
      },
      handledInboundIds: [],
      pendingInbounds: [],
    })
  })

  it('tracks id-backed inbound messages from pending to completed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const scopedDedupeKey = 'peer-1\u0000msg-1'

    await expect(
      recordInboundMessage(tempDir, {
        peerId: 'peer-1',
        text: 'hello',
        contextToken: 'ctx-1',
        dedupeKey: 'msg-1',
      })
    ).resolves.toEqual({
      status: 'new',
      completionRefs: [scopedDedupeKey],
      state: {
        getUpdatesBuf: '',
        peerContextTokens: {
          'peer-1': 'ctx-1',
        },
        handledInboundIds: [],
        pendingInbounds: [
          {
            dedupeKey: scopedDedupeKey,
            peerId: 'peer-1',
            text: 'hello',
            contextToken: 'ctx-1',
          },
        ],
      },
    })

    await expect(
      recordInboundMessage(tempDir, {
        peerId: 'peer-1',
        text: 'hello',
        contextToken: 'ctx-2',
        dedupeKey: 'msg-1',
      })
    ).resolves.toEqual({
      status: 'pending',
      completionRefs: [scopedDedupeKey],
      state: {
        getUpdatesBuf: '',
        peerContextTokens: {
          'peer-1': 'ctx-1',
        },
        handledInboundIds: [],
        pendingInbounds: [
          {
            dedupeKey: scopedDedupeKey,
            peerId: 'peer-1',
            text: 'hello',
            contextToken: 'ctx-1',
          },
        ],
      },
    })

    await completeInboundMessages(tempDir, [scopedDedupeKey])

    await expect(
      recordInboundMessage(tempDir, {
        peerId: 'peer-1',
        text: 'hello',
        contextToken: 'ctx-3',
        dedupeKey: 'msg-1',
      })
    ).resolves.toEqual({
      status: 'completed',
      completionRefs: [scopedDedupeKey],
      state: {
        getUpdatesBuf: '',
        peerContextTokens: {
          'peer-1': 'ctx-1',
        },
        handledInboundIds: [scopedDedupeKey],
        pendingInbounds: [],
      },
    })
  })
})
