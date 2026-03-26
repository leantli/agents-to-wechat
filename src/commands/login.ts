import qrcode from 'qrcode-terminal'
import { loadConfig } from '../config/load-config.js'
import { saveLoginState, startLogin, waitForLogin } from '../wechat/auth/login.js'
import type { FetchImpl } from '../wechat/protocol/types.js'

export async function runLogin(
  input: {
    baseUrl?: string
    stateDir?: string
    fetchImpl?: FetchImpl
    logger?: Pick<Console, 'log'>
  } = {}
): Promise<void> {
  const config = loadConfig({
    wechat: input.baseUrl ? { baseUrl: input.baseUrl } : undefined,
    storage: input.stateDir ? { stateDir: input.stateDir } : undefined,
  })
  const logger = input.logger ?? console
  const fetchImpl = input.fetchImpl ?? globalThis.fetch

  const session = await startLogin({
    baseUrl: config.wechat.baseUrl,
    fetchImpl,
  })

  logger.log('扫描二维码登录微信:')
  logger.log(session.qrcodeUrl)
  logger.log('')
  qrcode.generate(session.qrcodeUrl, { small: true })

  const loginState = await waitForLogin({
    baseUrl: config.wechat.baseUrl,
    qrcode: session.qrcode,
    fetchImpl,
  })

  if (!loginState.bot_token || !loginState.ilink_bot_id) {
    throw new Error('WeChat login succeeded but did not return bot credentials')
  }

  await saveLoginState({
    stateDir: config.storage.stateDir,
    loginState: {
      botToken: loginState.bot_token,
      botAccountId: loginState.ilink_bot_id,
      baseUrl: loginState.baseurl ?? config.wechat.baseUrl,
      botUserId: loginState.ilink_user_id,
    },
  })

  logger.log('WeChat login saved')
}
