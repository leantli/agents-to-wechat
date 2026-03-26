import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load-config.js'

describe('loadConfig', () => {
  it('builds defaults for a Node-only local install', () => {
    const config = loadConfig({})
    expect(config.agent.type).toBe('codex')
    expect(config.wechat.baseUrl).toBe('https://ilinkai.weixin.qq.com')
    expect(config.storage.stateDir).toContain('.agents-to-wechat')
  })

  it('honors an explicit storage state dir override', () => {
    const config = loadConfig({
      storage: { stateDir: '/tmp/custom-agent-state' },
    })

    expect(config.storage.stateDir).toBe('/tmp/custom-agent-state')
  })
})
