import { describe, expect, it, vi } from 'vitest'
import { CodexAcpAdapter } from '../../src/agents/codex-acp-adapter.js'
import type { AcpEventMessage, AcpRequestMessage } from '../../src/agents/acp-protocol.js'
import type { AcpTransport } from '../../src/agents/acp-transport.js'

interface FakeAcpTransportController {
  readonly requests: AcpRequestMessage[]
  emitEvent(event: AcpEventMessage): void
}

function createFakeAcpTransport(
  requestHandler: (
    message: AcpRequestMessage,
    controller: FakeAcpTransportController
  ) => Promise<unknown> | unknown
): {
  createTransport: (options: { onEvent: (event: AcpEventMessage) => void }) => AcpTransport
  controller: FakeAcpTransportController
} {
  const requests: AcpRequestMessage[] = []
  let onEvent: ((event: AcpEventMessage) => void) | undefined

  const controller: FakeAcpTransportController = {
    requests,
    emitEvent(event) {
      onEvent?.(event)
    },
  }

  return {
    controller,
    createTransport({ onEvent: nextOnEvent }): AcpTransport {
      onEvent = nextOnEvent

      return {
        async request(message) {
          requests.push(message)
          return await requestHandler(message, controller)
        },
        dispose() {},
      }
    },
  }
}

describe('CodexAcpAdapter', () => {
  it('creates one ACP session per peer and sends a prompt turn', async () => {
    const fake = createFakeAcpTransport(async (message, controller) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        })
        return {
          sessionId: 'sess-u1',
        }
      }

      if (message.method === 'session/prompt') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'hi',
              },
            },
          },
        })
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: ' there',
              },
            },
          },
        })
        return {
          stopReason: 'end_turn',
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const firstSessionId = await adapter.createSession('u1')
    const secondSessionId = await adapter.createSession('u1')

    await expect(adapter.sendPrompt(firstSessionId, 'hello')).resolves.toBe('hi there')
    expect(firstSessionId).toBe('sess-u1')
    expect(secondSessionId).toBe('sess-u1')
    expect(fake.controller.requests.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
  })

  it('deduplicates concurrent createSession calls for the same peer', async () => {
    const createSessionGate = vi.fn<() => void>()
    let resolveCreateSession: (() => void) | undefined

    const fake = createFakeAcpTransport(async (message) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        await new Promise<void>((resolve) => {
          resolveCreateSession = resolve
          createSessionGate()
        })
        return {
          sessionId: 'sess-u1',
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const first = adapter.createSession('u1')
    const second = adapter.createSession('u1')

    await vi.waitFor(() => {
      expect(createSessionGate).toHaveBeenCalledTimes(1)
    })

    resolveCreateSession?.()

    await expect(first).resolves.toBe('sess-u1')
    await expect(second).resolves.toBe('sess-u1')
    expect(fake.controller.requests.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
    ])
  })

  it('routes native commands through session/prompt without converting them to plain prompts', async () => {
    const fake = createFakeAcpTransport(async (message, controller) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'review',
                  description: 'Review the workspace',
                  input: {
                    hint: 'optional notes',
                  },
                },
              ],
            },
          },
        })
        return {
          sessionId: 'sess-u1',
        }
      }

      if (message.method === 'session/prompt') {
        return {
          stopReason: 'end_turn',
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const sessionId = await adapter.createSession('u1')

    await expect(
      adapter.executeNativeCommand(sessionId, '/review focus on tests')
    ).resolves.toEqual({
      logContext: {
        commandName: '/review',
      },
      status: 'completed',
      text: '',
    })

    expect(fake.controller.requests[2]).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'sess-u1',
        prompt: [
          {
            type: 'text',
            text: '/review focus on tests',
          },
        ],
      },
    })
  })

  it('forwards unknown slash commands even when they are absent from the advertised command list', async () => {
    const fake = createFakeAcpTransport(async (message, controller) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'review',
                  description: 'Review the workspace',
                  input: null,
                },
              ],
            },
          },
        })
        return {
          sessionId: 'sess-u1',
        }
      }

      if (message.method === 'session/prompt') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'handled by prompt path',
              },
            },
          },
        })
        return {
          stopReason: 'end_turn',
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const sessionId = await adapter.createSession('u1')

    await expect(adapter.executeNativeCommand(sessionId, '/foobar')).resolves.toEqual({
      logContext: {
        commandName: '/foobar',
      },
      status: 'completed',
      text: 'handled by prompt path',
    })
    expect(fake.controller.requests.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
  })

  it('times out a hung native command turn and recreates only that peer session', async () => {
    vi.useFakeTimers()

    try {
      let sessionCounter = 0

      const fake = createFakeAcpTransport(async (message, controller) => {
        if (message.method === 'initialize') {
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: true,
                audio: false,
                embeddedContext: true,
              },
              mcpCapabilities: {
                http: true,
                sse: false,
              },
              sessionCapabilities: {
                list: {},
                close: {},
              },
            },
            authMethods: [],
            agentInfo: {
              name: 'codex-acp',
              version: '0.10.0',
            },
          }
        }

        if (message.method === 'session/new') {
          sessionCounter += 1
          const sessionId = `sess-u1-${sessionCounter}`
          controller.emitEvent({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                  {
                    name: 'review',
                    description: 'Review the workspace',
                    input: null,
                  },
                ],
              },
            },
          })
          return {
            sessionId,
          }
        }

        if (message.method === 'session/prompt') {
          return await new Promise<never>(() => undefined)
        }

        throw new Error(`Unexpected ACP method: ${message.method}`)
      })

      const adapter = new CodexAcpAdapter({
        cwd: '/repo',
        turnTimeoutMs: 50,
        transportFactory: fake.createTransport,
      })

      const firstSessionId = await adapter.createSession('u1')
      const turnPromise = adapter.executeNativeCommand(firstSessionId, '/review')
      const turnExpectation = expect(turnPromise).rejects.toThrow(
        'ACP turn timed out after 50ms without activity'
      )

      await vi.advanceTimersByTimeAsync(50)

      await turnExpectation

      await expect(adapter.createSession('u1')).resolves.toBe('sess-u1-2')
      expect(fake.controller.requests.map((message) => message.method)).toEqual([
        'initialize',
        'session/new',
        'session/prompt',
        'session/new',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fail an active native command just because total wall time exceeds the timeout window', async () => {
    vi.useFakeTimers()

    try {
      let sessionPromptResolve: ((value: unknown) => void) | undefined

      const fake = createFakeAcpTransport(async (message, controller) => {
        if (message.method === 'initialize') {
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: true,
                audio: false,
                embeddedContext: true,
              },
              mcpCapabilities: {
                http: true,
                sse: false,
              },
              sessionCapabilities: {
                list: {},
                close: {},
              },
            },
            authMethods: [],
            agentInfo: {
              name: 'codex-acp',
              version: '0.10.0',
            },
          }
        }

        if (message.method === 'session/new') {
          controller.emitEvent({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-u1',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                  {
                    name: 'review',
                    description: 'Review the workspace',
                    input: null,
                  },
                ],
              },
            },
          })
          return {
            sessionId: 'sess-u1',
          }
        }

        if (message.method === 'session/prompt') {
          return await new Promise<unknown>((resolve) => {
            sessionPromptResolve = resolve
          })
        }

        throw new Error(`Unexpected ACP method: ${message.method}`)
      })

      const adapter = new CodexAcpAdapter({
        cwd: '/repo',
        turnTimeoutMs: 50,
        transportFactory: fake.createTransport,
      })

      const sessionId = await adapter.createSession('u1')
      const turnPromise = adapter.executeNativeCommand(sessionId, '/review')

      await vi.advanceTimersByTimeAsync(40)
      fake.controller.emitEvent({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-u1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'partial',
            },
          },
        },
      })

      await vi.advanceTimersByTimeAsync(40)
      sessionPromptResolve?.({
        stopReason: 'end_turn',
      })

      await expect(turnPromise).resolves.toEqual({
        logContext: {
          commandName: '/review',
        },
        status: 'completed',
        text: 'partial',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles /model without forwarding it through session/prompt', async () => {
    const fake = createFakeAcpTransport(async (message, controller) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        })
        return {
          sessionId: 'sess-u1',
          models: {
            currentModelId: 'gpt-5.4/xhigh',
            availableModels: [
              {
                modelId: 'gpt-5.4/high',
                name: 'gpt-5.4 (high)',
                description: 'high',
              },
              {
                modelId: 'gpt-5.4/xhigh',
                name: 'gpt-5.4 (xhigh)',
                description: 'xhigh',
              },
            ],
          },
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const sessionId = await adapter.createSession('u1')

    await expect(adapter.executeNativeCommand(sessionId, '/model')).resolves.toEqual({
      status: 'completed',
      text: ['当前模型：gpt-5.4/xhigh', '可用模型：', '- gpt-5.4/high', '- gpt-5.4/xhigh'].join(
        '\n'
      ),
      logContext: {
        commandAction: 'inspect_model',
        commandName: '/model',
        currentModelId: 'gpt-5.4/xhigh',
      },
    })

    expect(fake.controller.requests.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
    ])
  })

  it('does not intercept /models as the structured /model command', async () => {
    const fake = createFakeAcpTransport(async (message, controller) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        return {
          sessionId: 'sess-u1',
          models: {
            currentModelId: 'gpt-5.4/high',
            availableModels: [],
          },
        }
      }

      if (message.method === 'session/prompt') {
        controller.emitEvent({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-u1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'native slash forwarded',
              },
            },
          },
        })
        return {
          stopReason: 'end_turn',
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const sessionId = await adapter.createSession('u1')

    await expect(adapter.executeNativeCommand(sessionId, '/models')).resolves.toEqual({
      status: 'completed',
      text: 'native slash forwarded',
      logContext: {
        commandName: '/models',
      },
    })

    expect(fake.controller.requests.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
  })

  it('switches model through session/set_model when /model includes a target', async () => {
    const fake = createFakeAcpTransport(async (message) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        return {
          sessionId: 'sess-u1',
          models: {
            currentModelId: 'gpt-5.4/xhigh',
            availableModels: [
              {
                modelId: 'gpt-5.4/xhigh',
                name: 'gpt-5.4 (xhigh)',
                description: 'xhigh',
              },
              {
                modelId: 'gpt-5.3-codex/high',
                name: 'gpt-5.3-codex (high)',
                description: 'high',
              },
            ],
          },
        }
      }

      if (message.method === 'session/set_model') {
        return {}
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    const sessionId = await adapter.createSession('u1')

    await expect(
      adapter.executeNativeCommand(sessionId, '/model gpt-5.3-codex/high')
    ).resolves.toEqual({
      status: 'completed',
      text: '已切换到模型：gpt-5.3-codex/high',
      logContext: {
        commandAction: 'set_model',
        commandName: '/model',
        currentModelId: 'gpt-5.3-codex/high',
        requestedModel: 'gpt-5.3-codex/high',
        resolvedModel: 'gpt-5.3-codex/high',
      },
    })

    expect(fake.controller.requests[2]).toMatchObject({
      method: 'session/set_model',
      params: {
        sessionId: 'sess-u1',
        modelId: 'gpt-5.3-codex/high',
      },
    })
  })

  it('keeps other peer sessions usable when one turn times out from inactivity', async () => {
    vi.useFakeTimers()

    try {
      const fake = createFakeAcpTransport(async (message, controller) => {
        if (message.method === 'initialize') {
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: true,
                audio: false,
                embeddedContext: true,
              },
              mcpCapabilities: {
                http: true,
                sse: false,
              },
              sessionCapabilities: {
                list: {},
                close: {},
              },
            },
            authMethods: [],
            agentInfo: {
              name: 'codex-acp',
              version: '0.10.0',
            },
          }
        }

        if (message.method === 'session/new') {
          return {
            sessionId: message.id === 'acp-2' ? 'sess-u1' : 'sess-u2',
          }
        }

        if (message.method === 'session/prompt') {
          const params = message.params as { sessionId: string }
          if (params.sessionId === 'sess-u1') {
            return await new Promise<never>(() => undefined)
          }

          controller.emitEvent({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-u2',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'peer-2 ok',
                },
              },
            },
          })
          return {
            stopReason: 'end_turn',
          }
        }

        throw new Error(`Unexpected ACP method: ${message.method}`)
      })

      const adapter = new CodexAcpAdapter({
        cwd: '/repo',
        turnTimeoutMs: 50,
        transportFactory: fake.createTransport,
      })

      const session1 = await adapter.createSession('u1')
      const session2 = await adapter.createSession('u2')

      const timedOutTurn = adapter.sendPrompt(session1, 'hello from u1')
      const timedOutExpectation = expect(timedOutTurn).rejects.toThrow(
        'ACP turn timed out after 50ms without activity'
      )
      await vi.advanceTimersByTimeAsync(50)
      await timedOutExpectation

      await expect(adapter.sendPrompt(session2, 'hello from u2')).resolves.toBe('peer-2 ok')
      expect(fake.controller.requests.map((message) => message.method)).toEqual([
        'initialize',
        'session/new',
        'session/new',
        'session/prompt',
        'session/prompt',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds ignored stale session ids so they do not grow without limit', async () => {
    const fake = createFakeAcpTransport(async (message) => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              list: {},
              close: {},
            },
          },
          authMethods: [],
          agentInfo: {
            name: 'codex-acp',
            version: '0.10.0',
          },
        }
      }

      if (message.method === 'session/new') {
        return {
          sessionId: `sess-${message.id}`,
        }
      }

      throw new Error(`Unexpected ACP method: ${message.method}`)
    })

    const adapter = new CodexAcpAdapter({
      cwd: '/repo',
      transportFactory: fake.createTransport,
    })

    for (let index = 0; index < 300; index += 1) {
      const peerId = `u${index}`
      await adapter.createSession(peerId)
      adapter.resetSession(peerId)
    }

    const ignoredSessionIds = (
      adapter as unknown as {
        ignoredSessionIds: Set<string>
      }
    ).ignoredSessionIds

    expect(ignoredSessionIds.size).toBeLessThanOrEqual(256)
  })
})
