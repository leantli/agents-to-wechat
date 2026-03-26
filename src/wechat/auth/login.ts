import { readJson, writeJson } from '../../storage/json-store.js'
import { getStatePath } from '../../storage/paths.js'
import { getBotQrCode, getBotQrCodeStatus } from '../protocol/http-client.js'
import type {
  BotQrCodeSession,
  BotQrCodeStatusResponse,
  LoginStatus,
  FetchImpl,
  SavedLoginState,
} from '../protocol/types.js'

const KNOWN_LOGIN_STATUSES = new Set<LoginStatus>(['wait', 'scaned', 'confirmed', 'expired'])

export async function startLogin(input: {
  baseUrl: string
  fetchImpl?: FetchImpl
}): Promise<BotQrCodeSession> {
  const response = await getBotQrCode(input)

  return {
    qrcode: response.qrcode,
    qrcodeUrl: response.qrcode_img_content,
  }
}

export async function waitForLogin(input: {
  baseUrl: string
  qrcode: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<BotQrCodeStatusResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const timeoutMs = input.timeoutMs ?? 35_000
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startTime)

    try {
      const response = await getBotQrCodeStatus({
        baseUrl: input.baseUrl,
        qrcode: input.qrcode,
        fetchImpl,
        timeoutMs: remainingMs,
      })

      if (!KNOWN_LOGIN_STATUSES.has(response.status as LoginStatus)) {
        throw new Error(`Unexpected WeChat QR status: ${response.status}`)
      }

      if (response.status === 'confirmed') {
        if (!response.bot_token || !response.ilink_bot_id) {
          throw new Error('WeChat login succeeded but returned incomplete bot credentials')
        }

        return response
      }

      if (response.status === 'expired') {
        throw new Error('WeChat QR code expired')
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') {
        throw error
      }
    }

    const remainingAfterAttempt = timeoutMs - (Date.now() - startTime)
    if (remainingAfterAttempt <= 0) {
      break
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingAfterAttempt))
    )
  }

  throw new Error('Timed out waiting for WeChat login confirmation')
}

export async function saveLoginState(input: {
  stateDir: string
  loginState: SavedLoginState
}): Promise<SavedLoginState> {
  const filePath = getStatePath(input.stateDir, 'wechat-auth.json')
  await writeJson(filePath, input.loginState)
  return input.loginState
}

export async function readLoginState(stateDir: string): Promise<SavedLoginState | null> {
  return readJson<SavedLoginState>(getStatePath(stateDir, 'wechat-auth.json'))
}
