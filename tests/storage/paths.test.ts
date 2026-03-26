import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getStateDir, getStatePath } from '../../src/storage/paths.js'

describe('storage paths', () => {
  it('uses an explicit state dir override', () => {
    const stateDir = '/tmp/custom-agent-state'

    expect(getStateDir(stateDir)).toBe(stateDir)
    expect(getStatePath(stateDir, 'tokens.json')).toBe(join(stateDir, 'tokens.json'))
  })
})
