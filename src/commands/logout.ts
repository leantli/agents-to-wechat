import { access, rm } from 'node:fs/promises'
import { loadConfig } from '../config/load-config.js'
import { getStatePath } from '../storage/paths.js'

export interface LogoutResult {
  removed: boolean
  removedPaths: string[]
}

export interface RunLogoutInput {
  stateDir?: string
  logger?: Pick<Console, 'log'>
  accessImpl?: (path: string) => Promise<void>
  rmImpl?: (path: string) => Promise<void>
}

async function removeIfExistsWithImpl(
  filePath: string,
  accessImpl: (path: string) => Promise<unknown>,
  rmImpl: (path: string) => Promise<unknown>
): Promise<boolean> {
  try {
    await accessImpl(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }

  try {
    await rmImpl(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

export async function runLogout(input: RunLogoutInput = {}): Promise<LogoutResult> {
  const logger = input.logger ?? console
  const config = loadConfig({
    storage: input.stateDir ? { stateDir: input.stateDir } : undefined,
  })

  const authPath = getStatePath(config.storage.stateDir, 'wechat-auth.json')
  const syncPath = getStatePath(config.storage.stateDir, 'wechat-sync.json')
  const accessImpl = input.accessImpl ?? ((path: string) => access(path))
  const rmImpl = input.rmImpl ?? ((path: string) => rm(path))

  const removedPaths: string[] = []
  if (await removeIfExistsWithImpl(authPath, accessImpl, rmImpl)) {
    removedPaths.push(authPath)
  }
  if (await removeIfExistsWithImpl(syncPath, accessImpl, rmImpl)) {
    removedPaths.push(syncPath)
  }

  logger.log(
    removedPaths.length > 0
      ? `logout: removed ${String(removedPaths.length)} file(s)`
      : 'logout: nothing to remove'
  )

  return {
    removed: removedPaths.length > 0,
    removedPaths,
  }
}
