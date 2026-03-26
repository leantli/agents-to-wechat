import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLogin } from '../../src/commands/login.js'
import {
  readLoginState,
  saveLoginState,
  startLogin,
  waitForLogin,
} from '../../src/wechat/auth/login.js'

let tempDir: string | undefined

afterEach(async () => {
  vi.useRealTimers()

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('startLogin', () => {
  it('requests a QR code and returns the login session', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          qrcode: 'qr-token',
          qrcode_img_content: 'https://example.com/qr.png',
        }),
        { status: 200 }
      )
    )

    const result = await startLogin({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      fetchImpl,
    })

    expect(result.qrcode).toBe('qr-token')
    expect(result.qrcodeUrl).toBe('https://example.com/qr.png')
  })
})

describe('waitForLogin', () => {
  it('times out when a poll request hangs', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    await expect(
      waitForLogin({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        qrcode: 'qr-token',
        fetchImpl,
        timeoutMs: 25,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow('Timed out waiting for WeChat login confirmation')
  })

  it('rejects confirmed responses without credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'confirmed' }), { status: 200 }))

    await expect(
      waitForLogin({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        qrcode: 'qr-token',
        fetchImpl,
        timeoutMs: 50,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow('WeChat login succeeded but returned incomplete bot credentials')
  })

  it('rejects unexpected QR status values', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'drifted' }), { status: 200 }))

    await expect(
      waitForLogin({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        qrcode: 'qr-token',
        fetchImpl,
        timeoutMs: 50,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow('Unexpected WeChat QR status: drifted')
  })
})

describe('saveLoginState', () => {
  it('persists and reloads the login state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const loginState = {
      botToken: 'bot-token',
      botAccountId: 'bot-account',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botUserId: 'user-1',
    }

    await saveLoginState({
      stateDir: tempDir,
      loginState,
    })

    await expect(readLoginState(tempDir)).resolves.toEqual(loginState)
  })
})

describe('runLogin', () => {
  it('prints the QR URL and saves confirmed login state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-to-wechat-'))

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            qrcode: 'qr-token',
            qrcode_img_content: 'https://example.com/qr.png',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'bot-token',
            ilink_bot_id: 'bot-account',
            baseurl: 'https://ilinkai.weixin.qq.com',
            ilink_user_id: 'user-1',
          }),
          { status: 200 }
        )
      )
    const logger = { log: vi.fn() }

    await runLogin({
      stateDir: tempDir,
      fetchImpl,
      logger,
    })

    expect(logger.log).toHaveBeenCalledWith('https://example.com/qr.png')
    await expect(readLoginState(tempDir)).resolves.toEqual({
      botToken: 'bot-token',
      botAccountId: 'bot-account',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botUserId: 'user-1',
    })
  })
})
