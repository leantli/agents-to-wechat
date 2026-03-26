import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { FetchImpl } from './types.js'

export interface BaseInfo {
  channel_version: string
}

export interface WeChatInboundMessage {
  from_user_id?: string
  context_token?: string
  content?: string
  [key: string]: unknown
}

export interface GetUpdatesResponse {
  ret: number
  msgs: WeChatInboundMessage[]
  getUpdatesBuf: string
  [key: string]: unknown
}

function readChannelVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(dir, '..', '..', '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const CHANNEL_VERSION = readChannelVersion()

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

function buildClientId(): string {
  return `agents-to-wechat-${crypto.randomUUID()}`
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(input: { token: string; body: string }): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${input.token}`,
    'Content-Length': String(Buffer.byteLength(input.body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

const inboundMessageSchema = z
  .object({
    from_user_id: z.string().optional(),
    context_token: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough()

const getUpdatesResponseSchema = z
  .object({
    ret: z.number().optional(),
    msgs: z.array(inboundMessageSchema),
    get_updates_buf: z.string(),
  })
  .passthrough()

async function requestText(
  url: URL,
  fetchImpl: FetchImpl,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 35_000
): Promise<string> {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  let rejectTimer: ReturnType<typeof setTimeout> | undefined

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }),
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

    return await response.text()
  } finally {
    clearTimeout(abortTimer)
    if (rejectTimer) {
      clearTimeout(rejectTimer)
    }
  }
}

function emptyGetUpdatesResponse(input: { getUpdatesBuf?: string }): GetUpdatesResponse {
  return {
    ret: 0,
    msgs: [],
    getUpdatesBuf: input.getUpdatesBuf ?? '',
  }
}

function parseGetUpdatesResponse(rawText: string): GetUpdatesResponse {
  const parsed = getUpdatesResponseSchema.parse(JSON.parse(rawText))

  return {
    ...parsed,
    ret: parsed.ret ?? 0,
    msgs: parsed.msgs as WeChatInboundMessage[],
    getUpdatesBuf: parsed.get_updates_buf,
  }
}

export async function getUpdates(input: {
  baseUrl: string
  token: string
  botAccountId: string
  getUpdatesBuf?: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}): Promise<GetUpdatesResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = new URL('/ilink/bot/getupdates', input.baseUrl)
  const body = JSON.stringify({
    base_info: buildBaseInfo(),
    get_updates_buf: input.getUpdatesBuf ?? '',
  })

  try {
    const rawText = await requestText(
      url,
      fetchImpl,
      body,
      buildHeaders({
        token: input.token,
        body,
      }),
      input.timeoutMs
    )

    return parseGetUpdatesResponse(rawText)
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') {
      return emptyGetUpdatesResponse({
        getUpdatesBuf: input.getUpdatesBuf,
      })
    }

    throw error
  }
}

export async function sendMessage(input: {
  baseUrl: string
  token: string
  botAccountId: string
  peerId: string
  contextToken: string
  text: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = new URL('/ilink/bot/sendmessage', input.baseUrl)
  const body = JSON.stringify({
    base_info: buildBaseInfo(),
    msg: {
      from_user_id: '',
      to_user_id: input.peerId,
      client_id: buildClientId(),
      message_type: 2,
      message_state: 2,
      context_token: input.contextToken,
      item_list: [
        {
          type: 1,
          text_item: {
            text: input.text,
          },
        },
      ],
    },
  })

  await requestText(
    url,
    fetchImpl,
    body,
    buildHeaders({
      token: input.token,
      body,
    }),
    input.timeoutMs
  )
}
