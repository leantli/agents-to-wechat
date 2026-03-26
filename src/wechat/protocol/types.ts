export type FetchImpl = typeof fetch

export type LoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired'

export interface BotQrCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface BotQrCodeSession {
  qrcode: string
  qrcodeUrl: string
}

export interface BotQrCodeStatusResponse {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export interface SavedLoginState {
  botToken: string
  botAccountId: string
  baseUrl: string
  botUserId?: string
}
