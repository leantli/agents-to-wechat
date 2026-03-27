import { mkdir } from 'node:fs/promises'
import { loadConfig } from '../config/load-config.js'
import { readJson } from '../storage/json-store.js'
import { getStatePath } from '../storage/paths.js'
import { readLoginState } from '../wechat/auth/login.js'
import type { AppConfig } from '../config/schema.js'
import type { SavedLoginState } from '../wechat/protocol/types.js'
import {
  ensureCodexAcpAvailable,
  type ExecInstallImpl,
  type FindManagedPathImpl,
  type ValidateCodexAcpImpl,
} from './ensure-codex-acp.js'
import { findCommandOnPath, type WhichImpl } from './find-command-on-path.js'

export interface DoctorIssue {
  check: string
  message: string
}

export interface DoctorResult {
  ok: boolean
  issues: DoctorIssue[]
  config: AppConfig | null
}

export interface RunDoctorInput {
  stateDir?: string
  nodeVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  whichImpl?: WhichImpl
  execInstallImpl?: ExecInstallImpl
  validateImpl?: ValidateCodexAcpImpl
  findManagedPathImpl?: FindManagedPathImpl
  projectRoot?: string
  logger?: Pick<Console, 'log'>
}

function parseNodeVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) {
    return null
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }

  return {
    major,
    minor,
    patch,
  }
}

function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version)
  if (!parsed) {
    return false
  }

  if (parsed.major === 22) {
    return parsed.minor >= 12
  }

  return parsed.major >= 24
}

function isSavedLoginState(value: unknown): value is SavedLoginState {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<SavedLoginState>
  return (
    typeof candidate.botToken === 'string' &&
    candidate.botToken.length > 0 &&
    typeof candidate.botAccountId === 'string' &&
    candidate.botAccountId.length > 0 &&
    typeof candidate.baseUrl === 'string' &&
    candidate.baseUrl.length > 0 &&
    (() => {
      try {
        new URL(candidate.baseUrl)
        return true
      } catch {
        return false
      }
    })()
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.values(value).every((entry) => typeof entry === 'string')
}

function isRuntimeSafeSyncState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if ('getUpdatesBuf' in candidate && typeof candidate.getUpdatesBuf !== 'string') {
    return false
  }

  if ('peerContextTokens' in candidate && !isStringRecord(candidate.peerContextTokens)) {
    return false
  }

  if (
    'handledInboundIds' in candidate &&
    (!Array.isArray(candidate.handledInboundIds) ||
      !candidate.handledInboundIds.every((entry) => typeof entry === 'string'))
  ) {
    return false
  }

  if ('pendingInbounds' in candidate) {
    if (!Array.isArray(candidate.pendingInbounds)) {
      return false
    }

    for (const entry of candidate.pendingInbounds) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false
      }

      const record = entry as Record<string, unknown>
      if (
        typeof record.dedupeKey !== 'string' ||
        typeof record.peerId !== 'string' ||
        typeof record.text !== 'string' ||
        typeof record.contextToken !== 'string'
      ) {
        return false
      }
    }
  }

  return true
}

export async function runDoctor(input: RunDoctorInput = {}): Promise<DoctorResult> {
  const logger = input.logger ?? console
  const issues: DoctorIssue[] = []
  const nodeVersion = input.nodeVersion ?? process.version

  if (!isSupportedNodeVersion(nodeVersion)) {
    issues.push({
      check: 'node',
      message: `Node.js 22.12+ LTS or 24+ is required, found ${nodeVersion}`,
    })
  }

  const whichImpl = input.whichImpl ?? findCommandOnPath
  const codexPath = await whichImpl('codex')
  if (!codexPath) {
    issues.push({
      check: 'codex',
      message: 'codex is not available on PATH',
    })
  }

  if (codexPath) {
    try {
      await ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl: input.execInstallImpl,
        validateImpl: input.validateImpl,
        repair: false,
        findManagedPathImpl: input.findManagedPathImpl,
        projectRoot: input.projectRoot,
        stateDir: input.stateDir,
      })
    } catch (error) {
      issues.push({
        check: 'codex-acp',
        message: (error as Error).message,
      })
    }
  }

  let config: AppConfig | null = null
  try {
    config = loadConfig({
      storage: input.stateDir ? { stateDir: input.stateDir } : undefined,
    })
  } catch (error) {
    issues.push({
      check: 'config',
      message: `Config could not be loaded: ${(error as Error).message}`,
    })
  }

  if (config) {
    try {
      await mkdir(config.storage.stateDir, { recursive: true })
    } catch (error) {
      issues.push({
        check: 'stateDir',
        message: `State directory is not usable: ${(error as Error).message}`,
      })
    }

    try {
      const loginState = await readLoginState(config.storage.stateDir)
      if (!isSavedLoginState(loginState)) {
        issues.push({
          check: 'login',
          message: 'Saved WeChat login state is missing or malformed',
        })
      }
    } catch (error) {
      issues.push({
        check: 'login',
        message: `Saved WeChat login state could not be read: ${(error as Error).message}`,
      })
    }

    try {
      const syncState = await readJson<unknown>(
        getStatePath(config.storage.stateDir, 'wechat-sync.json')
      )
      if (syncState === null) {
        logger.log('[sync] Saved WeChat sync-state is missing (informational)')
      } else if (!isRuntimeSafeSyncState(syncState)) {
        issues.push({
          check: 'sync',
          message: 'Saved WeChat sync-state is malformed',
        })
      }
    } catch (error) {
      issues.push({
        check: 'sync',
        message: `Saved WeChat sync-state could not be read: ${(error as Error).message}`,
      })
    }
  }

  logger.log(issues.length === 0 ? 'doctor: ok' : `doctor: ${String(issues.length)} issue(s) found`)
  for (const issue of issues) {
    logger.log(`[${issue.check}] ${issue.message}`)
  }

  return {
    ok: issues.length === 0,
    issues,
    config,
  }
}
