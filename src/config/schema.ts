import { z } from 'zod'

export const AppConfigSchema = z.object({
  wechat: z.object({
    baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
  }),
  agent: z.object({
    type: z.enum(['codex']).default('codex'),
    command: z.string().default('codex'),
  }),
  storage: z.object({
    stateDir: z.string(),
  }),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
