import { describe, expect, it } from 'vitest'
import { createAcpTransport } from '../../src/agents/acp-transport.js'
import { createFakeAcpProcess } from './fake-acp-process.js'

describe('ACP transport', () => {
  it('matches responses by request id over stdio json lines', async () => {
    const fake = createFakeAcpProcess()
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    const result = await transport.request({
      id: 'req-1',
      method: 'ping',
      params: { value: 1 },
    })

    expect(result).toEqual({ ok: true })
    expect(fake.spawnCalls).toEqual([['codex-acp', [], { stdio: 'pipe' }]])
    expect(fake.requests).toEqual([
      {
        id: 'req-1',
        method: 'ping',
        params: { value: 1 },
      },
    ])
  })

  it('forwards event lines while keeping the request pending until the matching response arrives', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async (_request, helpers) => {
        helpers.emitEvent({ type: 'progress', detail: 'working' })
        helpers.respond({ id: 'req-2', result: { ok: true } })
      },
    })
    const events: unknown[] = []
    const transport = createAcpTransport({
      spawnImpl: fake.spawn,
      onEvent: (event) => {
        events.push(event)
      },
    })

    const result = await transport.request({
      id: 'req-2',
      method: 'ping',
      params: { value: 2 },
    })

    expect(result).toEqual({ ok: true })
    expect(events).toEqual([{ type: 'progress', detail: 'working' }])
  })

  it('rejects pending requests when the process exits before responding', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async (_request, helpers) => {
        helpers.exit(1)
      },
    })
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    await expect(
      transport.request({
        id: 'req-3',
        method: 'ping',
        params: { value: 3 },
      })
    ).rejects.toThrow(/exited/i)
  })

  it('buffers partial stdout chunks until a full json line is available', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async (_request, helpers) => {
        helpers.emitRawStdout('{"type":"progress"')
        helpers.emitRawStdout(',"detail":"working"}\n')
        helpers.emitRawStdout('{"id":"req-4","result":{"ok":true}}\n')
      },
    })
    const events: unknown[] = []
    const transport = createAcpTransport({
      spawnImpl: fake.spawn,
      onEvent: (event) => {
        events.push(event)
      },
    })

    const result = await transport.request({
      id: 'req-4',
      method: 'ping',
      params: { value: 4 },
    })

    expect(result).toEqual({ ok: true })
    expect(events).toEqual([{ type: 'progress', detail: 'working' }])
  })

  it('rejects a matching ACP error response', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async (request, helpers) => {
        helpers.respond({
          id: request.id,
          error: {
            message: 'request failed',
          },
        })
      },
    })
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    await expect(
      transport.request({
        id: 'req-5',
        method: 'ping',
        params: { value: 5 },
      })
    ).rejects.toThrow('request failed')
  })

  it('rejects the pending request when stdin emits an asynchronous error', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async () => undefined,
      onWrite: ({ failStdin }) => {
        failStdin(new Error('broken pipe'))
      },
    })
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    await expect(
      transport.request({
        id: 'req-6',
        method: 'ping',
        params: { value: 6 },
      })
    ).rejects.toThrow('broken pipe')
  })

  it('matches responses by request id when multiple requests are in flight', async () => {
    const fake = createFakeAcpProcess({
      onRequest: async (request, helpers) => {
        if (request.id === 'req-7-a') {
          setTimeout(() => {
            helpers.respond({ id: request.id, result: { order: 'first' } })
          }, 0)
          return
        }

        helpers.respond({ id: request.id, result: { order: 'second' } })
      },
    })
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    const first = transport.request({
      id: 'req-7-a',
      method: 'ping',
      params: { value: 'a' },
    })
    const second = transport.request({
      id: 'req-7-b',
      method: 'ping',
      params: { value: 'b' },
    })

    await expect(second).resolves.toEqual({ order: 'second' })
    await expect(first).resolves.toEqual({ order: 'first' })
  })

  it('drains stderr so the ACP child cannot block on an unread error pipe', async () => {
    const fake = createFakeAcpProcess()
    const transport = createAcpTransport({ spawnImpl: fake.spawn })

    await transport.request({
      id: 'req-8',
      method: 'ping',
      params: { value: 8 },
    })

    expect(fake.processes).toHaveLength(1)
    expect(fake.processes[0]?.stderr.listenerCount('data')).toBeGreaterThan(0)
  })
})
