import { CodexAcpAdapter } from '../agents/codex-acp-adapter.js'
import { createRuntimeLogger } from '../logging/runtime-logger.js'
import { createConfiguredStartService } from '../app/start-service.js'
import { loadConfig } from '../config/load-config.js'
import type { FetchImpl } from '../wechat/protocol/types.js'
import {
  ensureCodexAcpAvailable,
  type ExecInstallImpl,
  type FindManagedPathImpl,
  type ValidateCodexAcpImpl,
} from './ensure-codex-acp.js'
import type { WhichImpl } from './find-command-on-path.js'
import { findCommandOnPath } from './find-command-on-path.js'

export async function runStart(
  input: {
    baseUrl?: string
    stateDir?: string
    command?: string
    fetchImpl?: FetchImpl
    whichImpl?: WhichImpl
    execInstallImpl?: ExecInstallImpl
    validateImpl?: ValidateCodexAcpImpl
    findManagedPathImpl?: FindManagedPathImpl
    projectRoot?: string
  } = {}
): Promise<void> {
  const config = loadConfig({
    wechat: input.baseUrl ? { baseUrl: input.baseUrl } : undefined,
    agent: input.command ? { command: input.command } : undefined,
    storage: input.stateDir ? { stateDir: input.stateDir } : undefined,
  })

  const whichImpl = input.whichImpl ?? findCommandOnPath
  const codexPath = await whichImpl(config.agent.command)
  if (!codexPath) {
    throw new Error(`Agent command is not available on PATH: ${config.agent.command}`)
  }

  const codexAcpPath = await ensureCodexAcpAvailable({
    whichImpl,
    execInstallImpl: input.execInstallImpl,
    validateImpl: input.validateImpl,
    findManagedPathImpl: input.findManagedPathImpl,
    projectRoot: input.projectRoot,
    stateDir: config.storage.stateDir,
  })

  const logger = createRuntimeLogger({
    stateDir: config.storage.stateDir,
  })

  const adapter = new CodexAcpAdapter({
    cwd: process.cwd(),
    command: codexAcpPath,
  })

  const service = await createConfiguredStartService({
    stateDir: config.storage.stateDir,
    adapter,
    logger,
    fetchImpl: input.fetchImpl,
  })

  logger.info('service.starting', {
    agentCommand: codexPath,
    acpCommand: codexAcpPath,
    logPath: logger.logPath,
    stateDir: config.storage.stateDir,
  })

  await service.start()
}
