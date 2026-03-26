import {
  spawn as defaultSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import {
  isAcpResponseMessage,
  type AcpEventMessage,
  type AcpRequestMessage,
} from './acp-protocol.js'

export type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8')
  }

  return String(chunk)
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export interface AcpTransport {
  request(
    message: AcpRequestMessage,
    options?: {
      signal?: AbortSignal
    }
  ): Promise<unknown>
  dispose(): void
}

export interface CreateAcpTransportOptions {
  command?: string
  args?: string[]
  spawnImpl?: SpawnImpl
  onEvent?: (event: AcpEventMessage) => void
}

class DefaultAcpTransport implements AcpTransport {
  private readonly spawnImpl: SpawnImpl
  private readonly command: string
  private readonly args: string[]
  private readonly pending = new Map<string, PendingRequest>()

  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''

  constructor(private readonly options: CreateAcpTransportOptions) {
    this.spawnImpl = options.spawnImpl ?? defaultSpawn
    this.command = options.command ?? 'codex-acp'
    this.args = options.args ?? []
  }

  async request(
    message: AcpRequestMessage,
    options?: {
      signal?: AbortSignal
    }
  ): Promise<unknown> {
    if (this.pending.has(message.id)) {
      throw new Error(`ACP request id is already pending: ${message.id}`)
    }

    if (options?.signal?.aborted) {
      throw new Error(`ACP request aborted: ${message.id}`)
    }

    const child = this.ensureChild()

    return await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        options?.signal?.removeEventListener('abort', onAbort)
      }
      const finishResolve = (result: unknown) => {
        cleanup()
        resolve(result)
      }
      const finishReject = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onAbort = () => {
        this.pending.delete(message.id)
        finishReject(new Error(`ACP request aborted: ${message.id}`))
      }

      options?.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(message.id, { resolve: finishResolve, reject: finishReject })

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        this.pending.delete(message.id)
        finishReject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    const child = this.child
    this.child = null
    this.buffer = ''
    this.rejectAll(new Error('ACP transport disposed'))

    if (child) {
      try {
        child.kill()
      } catch {
        // Best-effort disposal only.
      }
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child
    }

    const child = this.spawnImpl(this.command, this.args, { stdio: 'pipe' })
    this.child = child
    this.buffer = ''

    child.stdout.on('data', (chunk: unknown) => {
      this.onStdoutData(chunk)
    })
    child.stderr.on('data', () => {
      // Drain stderr so the child process cannot block on a full pipe.
    })

    child.once('error', (error) => {
      this.handleProcessFailure(error instanceof Error ? error : new Error(String(error)))
    })

    child.stdin.once('error', (error) => {
      this.handleProcessFailure(error instanceof Error ? error : new Error(String(error)))
    })

    child.once('exit', (code, signal) => {
      const reason = signal
        ? `ACP process exited with signal ${signal}`
        : `ACP process exited with code ${String(code ?? 'unknown')}`
      this.handleProcessFailure(new Error(reason))
    })

    return child
  }

  private onStdoutData(chunk: unknown): void {
    this.buffer += toText(chunk)

    for (;;) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }

      const rawLine = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)

      const line = rawLine.trim()
      if (!line) {
        continue
      }

      this.handleMessageLine(line)
    }
  }

  private handleMessageLine(line: string): void {
    let parsed: unknown

    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      return
    }

    if (isAcpResponseMessage(parsed)) {
      const pending = this.pending.get(parsed.id)
      if (!pending) {
        return
      }

      this.pending.delete(parsed.id)

      if ('error' in parsed) {
        pending.reject(new Error(parsed.error.message))
        return
      }

      pending.resolve(parsed.result)
      return
    }

    if (typeof parsed === 'object' && parsed !== null) {
      this.options.onEvent?.(parsed as AcpEventMessage)
    }
  }

  private handleProcessFailure(error: Error): void {
    this.child = null
    this.buffer = ''
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    const pendingEntries = [...this.pending.values()]
    this.pending.clear()

    for (const pending of pendingEntries) {
      pending.reject(error)
    }
  }
}

export function createAcpTransport(options: CreateAcpTransportOptions = {}): AcpTransport {
  return new DefaultAcpTransport(options)
}
