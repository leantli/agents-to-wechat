import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import type {
  AcpEventMessage,
  AcpRequestMessage,
  AcpResponseMessage,
} from '../../src/agents/acp-protocol.js'

function toText(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8')
}

function parseRequestLine(line: string): AcpRequestMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      typeof (parsed as { method?: unknown }).method !== 'string'
    ) {
      return null
    }

    return parsed as AcpRequestMessage
  } catch {
    return null
  }
}

class FakeWritable extends EventEmitter {
  constructor(private readonly owner: FakeAcpChildProcess) {
    super()
  }

  write(chunk: string | Buffer): boolean {
    this.owner.acceptWrite(toText(chunk))
    return true
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) {
      this.write(chunk)
    }
  }
}

class FakeReadable extends EventEmitter {
  pushChunk(chunk: string): void {
    this.emit('data', Buffer.from(chunk))
  }

  pushLine(line: string): void {
    this.pushChunk(`${line}\n`)
  }
}

interface FakeAcpHelpers {
  respond(response: AcpResponseMessage): void
  emitEvent(event: AcpEventMessage): void
  emitRawStdout(chunk: string): void
  failStdin(error: Error): void
  exit(code?: number, signal?: NodeJS.Signals | null): void
}

class FakeAcpChildProcess extends EventEmitter {
  public readonly stdin: FakeWritable
  public readonly stdout: FakeReadable
  public readonly stderr: FakeReadable
  public readonly requests: AcpRequestMessage[] = []

  constructor(
    private readonly onWrite: ((helpers: Pick<FakeAcpHelpers, 'failStdin'>) => void) | undefined,
    private readonly handleRequest: (
      request: AcpRequestMessage,
      helpers: FakeAcpHelpers
    ) => void | Promise<void>
  ) {
    super()
    this.stdin = new FakeWritable(this)
    this.stdout = new FakeReadable()
    this.stderr = new FakeReadable()
  }

  acceptWrite(chunk: string): void {
    this.onWrite?.({
      failStdin: (error) => {
        queueMicrotask(() => {
          this.stdin.emit('error', error)
        })
      },
    })

    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      const request = parseRequestLine(line)
      if (!request) {
        continue
      }

      this.requests.push(request)
      void this.handleRequest(request, {
        respond: (response) => {
          this.emitResponse(response)
        },
        emitEvent: (event) => {
          this.emitEvent(event)
        },
        emitRawStdout: (chunk) => {
          this.stdout.pushChunk(chunk)
        },
        failStdin: (error) => {
          queueMicrotask(() => {
            this.stdin.emit('error', error)
          })
        },
        exit: (code = 0, signal = null) => {
          this.emitExit(code, signal)
        },
      })
    }
  }

  emitResponse(response: AcpResponseMessage): void {
    this.stdout.pushLine(JSON.stringify(response))
  }

  emitEvent(event: AcpEventMessage): void {
    this.stdout.pushLine(JSON.stringify(event))
  }

  emitExit(code: number, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
}

interface FakeAcpProcessOptions {
  onWrite?: (helpers: Pick<FakeAcpHelpers, 'failStdin'>) => void
  onRequest?: (request: AcpRequestMessage, helpers: FakeAcpHelpers) => void | Promise<void>
}

export function createFakeAcpProcess(options: FakeAcpProcessOptions = {}): {
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams
  spawnCalls: Array<[string, string[], SpawnOptionsWithoutStdio]>
  readonly requests: AcpRequestMessage[]
  processes: FakeAcpChildProcess[]
} {
  const spawnCalls: Array<[string, string[], SpawnOptionsWithoutStdio]> = []
  const processes: FakeAcpChildProcess[] = []
  const defaultHandler = async (
    request: AcpRequestMessage,
    helpers: FakeAcpHelpers
  ): Promise<void> => {
    helpers.respond({ id: request.id, result: { ok: true } })
  }
  const handleRequest = options.onRequest ?? defaultHandler

  return {
    spawn(command: string, args: string[], spawnOptions: SpawnOptionsWithoutStdio) {
      spawnCalls.push([command, args, spawnOptions])
      const process = new FakeAcpChildProcess(options.onWrite, handleRequest)
      processes.push(process)
      return process as never
    },
    spawnCalls,
    get requests() {
      return processes.flatMap((process) => process.requests)
    },
    processes,
  }
}
