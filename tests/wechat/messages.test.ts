import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getUpdates, sendMessage } from '../../src/wechat/protocol/messages.js'

const packageVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    version?: string
  }
).version

describe('wechat message transport', () => {
  it('generates X-WECHAT-UIN from a random uint32', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    await getUpdates({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      getUpdatesBuf: 'prev-buf',
      fetchImpl,
    })

    const [, init] = fetchImpl.mock.calls[0]
    const header = String((init?.headers as Record<string, string>)['X-WECHAT-UIN'])
    const decoded = Buffer.from(header, 'base64').toString('utf8')

    expect(decoded).toMatch(/^\d+$/)
    expect(header).not.toBe('bot-account')
  })

  it('posts getupdates with the cached sync buffer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [],
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    const response = await getUpdates({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      getUpdatesBuf: 'prev-buf',
      fetchImpl,
    })

    expect(response.getUpdatesBuf).toBe('next-buf')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer bot-token',
    })

    const body = JSON.parse(String(init?.body))
    expect(body.get_updates_buf).toBe('prev-buf')
    expect(body.base_info).toEqual({ channel_version: packageVersion })
  })

  it('accepts real getupdates responses that omit ret and include sync_buf', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          msgs: [],
          sync_buf: 'legacy-sync-buf',
          get_updates_buf: 'next-buf',
        }),
        { status: 200 }
      )
    )

    const response = await getUpdates({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      getUpdatesBuf: 'prev-buf',
      fetchImpl,
    })

    expect(response.ret).toBe(0)
    expect(response.msgs).toEqual([])
    expect(response.getUpdatesBuf).toBe('next-buf')
    expect(response.sync_buf).toBe('legacy-sync-buf')
  })

  it('treats a client-side timeout as an empty poll', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))

    const response = await getUpdates({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
      botAccountId: 'bot-account',
      getUpdatesBuf: 'prev-buf',
      fetchImpl,
      timeoutMs: 10,
    })

    expect(response).toEqual({
      ret: 0,
      msgs: [],
      getUpdatesBuf: 'prev-buf',
    })
  })

  it('posts sendmessage with the peer context token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))

    await expect(
      sendMessage({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        peerId: 'peer-1',
        contextToken: 'ctx-1',
        text: 'hello',
        fetchImpl,
      })
    ).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer bot-token',
    })

    const body = JSON.parse(String(init?.body))
    expect(body.base_info).toEqual({ channel_version: packageVersion })
    expect(body.msg).toMatchObject({
      from_user_id: '',
      to_user_id: 'peer-1',
      context_token: 'ctx-1',
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 1,
          text_item: { text: 'hello' },
        },
      ],
    })
    expect(body.msg.client_id).toEqual(expect.any(String))
    expect(body.msg.client_id).toMatch(/^agents-to-wechat-/)
    expect(body.msg.client_id.length).toBeGreaterThan(0)
    expect(body.message).toBeUndefined()
    expect(body.peer_id).toBeUndefined()
    expect(body.text).toBeUndefined()
  })

  it('rejects malformed 200 responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ret: 0 }), { status: 200 }))

    await expect(
      getUpdates({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        getUpdatesBuf: 'prev-buf',
        fetchImpl,
      })
    ).rejects.toThrow()
  })

  it('treats empty 2xx send responses as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))

    await expect(
      sendMessage({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'bot-token',
        botAccountId: 'bot-account',
        peerId: 'peer-1',
        contextToken: 'ctx-1',
        text: 'hello',
        fetchImpl,
      })
    ).resolves.toBeUndefined()
  })
})
