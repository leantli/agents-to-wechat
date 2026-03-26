import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStateDir } from '../storage/paths.js'
import {
  findBundledCommandPath,
  findCommandOnPath,
  getManagedCodexAcpInstallRoot,
  type WhichImpl,
} from './find-command-on-path.js'

export type ExecInstallImpl = () => Promise<void>
export type ValidateCodexAcpImpl = (commandPath: string) => Promise<void>
export type FindManagedPathImpl = (
  command: string,
  input?: {
    projectRoot?: string
    platform?: NodeJS.Platform
    stateDir?: string
  }
) => Promise<string | null>

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CODEX_ACP_PACKAGE_NAME = '@zed-industries/codex-acp'

export interface EnsureCodexAcpInput {
  whichImpl?: WhichImpl
  execInstallImpl?: ExecInstallImpl
  validateImpl?: ValidateCodexAcpImpl
  repair?: boolean
  projectRoot?: string
  platform?: NodeJS.Platform
  stateDir?: string
  findManagedPathImpl?: FindManagedPathImpl
}

export function getManagedCodexAcpPackageSpec(projectRoot = DEFAULT_PROJECT_ROOT): string {
  const packageJsonPath = join(projectRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  const version = packageJson.dependencies?.[CODEX_ACP_PACKAGE_NAME]

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${CODEX_ACP_PACKAGE_NAME} is not declared in package.json`)
  }

  return `${CODEX_ACP_PACKAGE_NAME}@${version}`
}

export function getDefaultRepairInstallArgs(
  projectRoot = DEFAULT_PROJECT_ROOT,
  stateDir: string
): string[] {
  return [
    'install',
    '--prefix',
    getManagedCodexAcpInstallRoot(stateDir),
    '--no-fund',
    '--no-audit',
    '--no-save',
    getManagedCodexAcpPackageSpec(projectRoot),
  ]
}

// eslint-disable-next-line @typescript-eslint/require-await
async function runDefaultRepairInstall(
  projectRoot = DEFAULT_PROJECT_ROOT,
  stateDir: string
): Promise<void> {
  const result = spawnSync('npm', getDefaultRepairInstallArgs(projectRoot, stateDir), {
    cwd: projectRoot,
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`npm repair install failed: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const reason = `exit code ${String(result.status ?? 'unknown')}`
    throw new Error(`npm repair install failed: ${reason}`)
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function validateCodexAcpAvailable(commandPath: string): Promise<void> {
  const result = spawnSync(commandPath, ['--help'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  })

  if (result.error) {
    throw new Error(result.error.message)
  }

  if (result.status !== 0) {
    throw new Error(`exit code ${String(result.status ?? 'unknown')}`)
  }
}

export async function ensureCodexAcpAvailable(input: EnsureCodexAcpInput = {}): Promise<string> {
  const whichImpl = input.whichImpl ?? findCommandOnPath
  const projectRoot = input.projectRoot ?? DEFAULT_PROJECT_ROOT
  const platform = input.platform ?? process.platform
  const stateDir = getStateDir(input.stateDir)
  const findManagedPathImpl = input.findManagedPathImpl ?? findBundledCommandPath
  const execInstallImpl =
    input.execInstallImpl ?? (async () => runDefaultRepairInstall(projectRoot, stateDir))
  const validateImpl = input.validateImpl ?? validateCodexAcpAvailable
  const repair = input.repair ?? true

  const codexPath = await whichImpl('codex')
  if (!codexPath) {
    throw new Error('codex is not available on PATH')
  }

  const initialManagedPath = await findManagedPathImpl('codex-acp', {
    projectRoot,
    platform,
    stateDir,
  })
  const initialPathFromPath = await whichImpl('codex-acp')
  const initialCandidates = Array.from(
    new Set(
      [initialManagedPath, initialPathFromPath].filter((value): value is string => Boolean(value))
    )
  )
  let initialValidationError: Error | null = null
  for (const initialPath of initialCandidates) {
    try {
      await validateImpl(initialPath)
      return initialPath
    } catch (error) {
      initialValidationError = error as Error
    }
  }

  if (!repair) {
    if (initialValidationError) {
      throw new Error(`codex-acp failed to start: ${initialValidationError.message}`)
    }
    throw new Error('codex-acp is not available')
  }

  await execInstallImpl()

  const repairedManagedPath = await findManagedPathImpl('codex-acp', {
    projectRoot,
    platform,
    stateDir,
  })
  const repairedPathFromPath = await whichImpl('codex-acp')
  const repairedCandidates = Array.from(
    new Set(
      [repairedManagedPath, repairedPathFromPath].filter((value): value is string => Boolean(value))
    )
  )
  let repairedValidationError: Error | null = null
  for (const repairedPath of repairedCandidates) {
    try {
      await validateImpl(repairedPath)
      return repairedPath
    } catch (error) {
      repairedValidationError = error as Error
    }
  }

  if (repairedValidationError) {
    throw new Error(
      `codex-acp failed to start after repair install: ${repairedValidationError.message}`
    )
  }

  throw new Error('codex-acp is not available after repair install')
}
