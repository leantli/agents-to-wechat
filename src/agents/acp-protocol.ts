export interface AcpRequestMessage {
  id: string
  method: string
  params?: unknown
}

export interface AcpErrorPayload {
  message: string
  code?: number | string
  data?: unknown
}

export interface AcpResultResponseMessage {
  id: string
  result: unknown
}

export interface AcpErrorResponseMessage {
  id: string
  error: AcpErrorPayload
}

export type AcpResponseMessage = AcpResultResponseMessage | AcpErrorResponseMessage

export type AcpEventMessage = Record<string, unknown>

export function isAcpRequestMessage(value: unknown): value is AcpRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { method?: unknown }).method === 'string'
  )
}

export function isAcpResponseMessage(value: unknown): value is AcpResponseMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'string'
  ) {
    return false
  }

  if ('result' in value) {
    return true
  }

  if (!('error' in value)) {
    return false
  }

  const error = (value as { error?: unknown }).error
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}
