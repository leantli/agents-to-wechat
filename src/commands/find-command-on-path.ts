import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStatePath } from '../storage/paths.js'

export type WhichImpl = (command: string) => Promise<string | null>

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export function getManagedCodexAcpInstallRoot(stateDir: string): string {
  return getStatePath(stateDir, 'vendor', 'codex-acp')
}

export async function findBundledCommandPath(
  command: string,
  input: {
    projectRoot?: string
    platform?: NodeJS.Platform
    stateDir?: string
  } = {}
): Promise<string | null> {
  if (command !== 'codex-acp') {
    return null
  }

  const projectRoot = input.projectRoot ?? DEFAULT_PROJECT_ROOT
  const platform = input.platform ?? process.platform
  const searchRoots = input.stateDir
    ? [getManagedCodexAcpInstallRoot(input.stateDir), projectRoot]
    : [projectRoot]
  const candidates =
    platform === 'win32' ? ['codex-acp.cmd', 'codex-acp.ps1', 'codex-acp'] : ['codex-acp']

  for (const root of searchRoots) {
    for (const candidate of candidates) {
      const candidatePath = join(root, 'node_modules', '.bin', candidate)

      try {
        await access(candidatePath)
        return candidatePath
      } catch {
        // Keep scanning the other bundled binary candidates.
      }
    }
  }

  return null
}

export async function findCommandOnPath(command: string): Promise<string | null> {
  const bundledPath = await findBundledCommandPath(command)
  if (bundledPath) {
    return bundledPath
  }

  if (process.platform === 'win32') {
    const result = spawnSync('where', [command], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return result.stdout.trim().split(/\r?\n/)[0] ?? null
    }

    return null
  }

  const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
  })
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim()
  }

  return null
}
