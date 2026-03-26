import { homedir } from 'node:os'
import { join } from 'node:path'

export function getStateDir(stateDir?: string): string {
  return stateDir ?? join(homedir(), '.agents-to-wechat')
}

export function getStatePath(stateDir: string, ...segments: string[]): string {
  return join(getStateDir(stateDir), ...segments)
}
