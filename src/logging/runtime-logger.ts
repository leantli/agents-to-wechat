import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { getStatePath } from '../storage/paths.js'

type LogValue = string | number | boolean | null | undefined

export interface RuntimeLogger {
  readonly logPath: string
  info(event: string, fields?: Record<string, LogValue>): void
  warn(event: string, fields?: Record<string, LogValue>): void
  error(event: string, fields?: Record<string, LogValue>): void
  flush(): Promise<void>
}

export interface CreateRuntimeLoggerOptions {
  stateDir: string
  consoleImpl?: Pick<Console, 'log' | 'warn' | 'error'>
}

const LOG_FILE_NAME = 'agents-to-wechat.log'

function formatFieldValue(value: Exclude<LogValue, undefined>): string {
  return JSON.stringify(value)
}

function formatLine(
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  fields: Record<string, LogValue> | undefined
): string {
  const base = `${new Date().toISOString()} ${level} ${event}`
  const serializedFields = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatFieldValue(value as Exclude<LogValue, undefined>)}`)
    .join(' ')

  return serializedFields.length > 0 ? `${base} ${serializedFields}` : base
}

export function createRuntimeLogger(options: CreateRuntimeLoggerOptions): RuntimeLogger {
  const consoleImpl = options.consoleImpl ?? console
  const logPath = getStatePath(options.stateDir, LOG_FILE_NAME)
  let writeChain: Promise<void> = mkdir(options.stateDir, {
    recursive: true,
    mode: 0o700,
  }).then(async () => {
    await chmod(options.stateDir, 0o700)
  })

  const enqueueWrite = (
    level: 'INFO' | 'WARN' | 'ERROR',
    event: string,
    fields: Record<string, LogValue> | undefined
  ): void => {
    const line = formatLine(level, event, fields)

    if (level === 'ERROR') {
      consoleImpl.error(line)
    } else if (level === 'WARN') {
      consoleImpl.warn(line)
    } else {
      consoleImpl.log(line)
    }

    writeChain = writeChain
      .then(async () => {
        await appendFile(logPath, `${line}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await chmod(options.stateDir, 0o700)
        await chmod(logPath, 0o600)
      })
      .catch((error: unknown) => {
        const writeErrorLine = formatLine('ERROR', 'logger.write_failed', {
          error: error instanceof Error ? error.message : String(error),
          logPath,
        })
        consoleImpl.error(writeErrorLine)
      })
  }

  return {
    logPath,
    info(event, fields) {
      enqueueWrite('INFO', event, fields)
    },
    warn(event, fields) {
      enqueueWrite('WARN', event, fields)
    },
    error(event, fields) {
      enqueueWrite('ERROR', event, fields)
    },
    async flush() {
      await writeChain
    },
  }
}
