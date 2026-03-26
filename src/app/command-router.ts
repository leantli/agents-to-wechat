import type { AgentInboundTurn } from '../agents/types.js'

export function routeInboundText(text: string): AgentInboundTurn {
  if (text.startsWith('/')) {
    return {
      kind: 'native_command',
      text,
    }
  }

  return {
    kind: 'prompt',
    text,
  }
}
