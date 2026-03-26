import { describe, expect, it } from 'vitest'
import { routeInboundText } from '../../src/app/command-router.js'

describe('routeInboundText', () => {
  it('routes slash-prefixed input as a native command', () => {
    expect(routeInboundText('/model')).toEqual({
      kind: 'native_command',
      text: '/model',
    })
  })

  it('routes normal input as a prompt', () => {
    expect(routeInboundText('hello')).toEqual({
      kind: 'prompt',
      text: 'hello',
    })
  })
})
