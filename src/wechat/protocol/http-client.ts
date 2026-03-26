import type { BotQrCodeResponse, BotQrCodeStatusResponse, FetchImpl } from './types.js'

async function requestJson<T>(url: URL, fetchImpl: FetchImpl, timeoutMs = 35_000): Promise<T> {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  let rejectTimer: ReturnType<typeof setTimeout> | undefined

  try {
    const response = await Promise.race([
      fetchImpl(url, { signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        rejectTimer = setTimeout(() => {
          const error = new Error(`Request timed out after ${String(timeoutMs)}ms`)
          error.name = 'AbortError'
          reject(error)
        }, timeoutMs)
      }),
    ])

    if (!response.ok) {
      throw new Error(`Request failed with status ${String(response.status)}`)
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(abortTimer)
    if (rejectTimer) {
      clearTimeout(rejectTimer)
    }
  }
}

export async function getBotQrCode(input: {
  baseUrl: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}): Promise<BotQrCodeResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = new URL('/ilink/bot/get_bot_qrcode', input.baseUrl)
  url.searchParams.set('bot_type', '3')

  return requestJson<BotQrCodeResponse>(url, fetchImpl, input.timeoutMs)
}

export async function getBotQrCodeStatus(input: {
  baseUrl: string
  qrcode: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}): Promise<BotQrCodeStatusResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = new URL('/ilink/bot/get_qrcode_status', input.baseUrl)
  url.searchParams.set('qrcode', input.qrcode)

  return requestJson<BotQrCodeStatusResponse>(url, fetchImpl, input.timeoutMs)
}
