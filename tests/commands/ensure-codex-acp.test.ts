import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureCodexAcpAvailable,
  getDefaultRepairInstallArgs,
} from '../../src/commands/ensure-codex-acp.js'

const EMPTY_PROJECT_ROOT = '/definitely-missing-agent-to-wechat-project-root'

describe('ensureCodexAcpAvailable', () => {
  it('returns the executable path when codex-acp is already available', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce('/tmp/codex-acp')
    const validateImpl = vi.fn(async () => undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl: vi.fn(),
        validateImpl,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).resolves.toBe('/tmp/codex-acp')
    expect(whichImpl.mock.calls.map(([command]) => command)).toEqual(['codex', 'codex-acp'])
    expect(validateImpl).toHaveBeenCalledTimes(1)
  })

  it('attempts repair installation when codex-acp is missing', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/tmp/codex-acp')
    const execInstallImpl = vi.fn(async () => undefined)
    const validateImpl = vi.fn(async () => undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        validateImpl,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).resolves.toBe('/tmp/codex-acp')
    expect(execInstallImpl).toHaveBeenCalledTimes(1)
    expect(validateImpl).toHaveBeenCalledTimes(1)
    expect(whichImpl.mock.calls.map(([command]) => command)).toEqual([
      'codex',
      'codex-acp',
      'codex-acp',
    ])
  })

  it('attempts repair when codex-acp is found but fails its health check', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce('/tmp/codex-acp')
      .mockResolvedValueOnce('/tmp/codex-acp')
    const execInstallImpl = vi.fn(async () => undefined)
    const validateImpl = vi.fn(async (_commandPath: string) => undefined)
    validateImpl.mockRejectedValueOnce(new Error('launcher failed'))
    validateImpl.mockResolvedValueOnce(undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        validateImpl,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).resolves.toBe('/tmp/codex-acp')
    expect(execInstallImpl).toHaveBeenCalledTimes(1)
    expect(validateImpl).toHaveBeenCalledTimes(2)
    expect(whichImpl.mock.calls.map(([command]) => command)).toEqual([
      'codex',
      'codex-acp',
      'codex-acp',
    ])
  })

  it('fails before repair when codex itself is missing', async () => {
    const whichImpl = vi.fn().mockResolvedValueOnce(null)
    const execInstallImpl = vi.fn(async () => undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).rejects.toThrow('codex is not available on PATH')
    expect(execInstallImpl).not.toHaveBeenCalled()
    expect(whichImpl.mock.calls.map(([command]) => command)).toEqual(['codex'])
  })

  it('can report missing codex-acp without attempting repair', async () => {
    const whichImpl = vi.fn().mockResolvedValueOnce('/tmp/codex').mockResolvedValueOnce(null)
    const execInstallImpl = vi.fn(async () => undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        repair: false,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).rejects.toThrow('codex-acp is not available')
    expect(execInstallImpl).not.toHaveBeenCalled()
    expect(whichImpl.mock.calls.map(([command]) => command)).toEqual(['codex', 'codex-acp'])
  })

  it('reports a failed codex-acp health check without repair when repair is disabled', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce('/tmp/codex-acp')
    const execInstallImpl = vi.fn(async () => undefined)
    const validateImpl = vi.fn(async () => {
      throw new Error('launcher failed')
    })

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        validateImpl,
        repair: false,
        projectRoot: EMPTY_PROJECT_ROOT,
      })
    ).rejects.toThrow('codex-acp failed to start')
    expect(execInstallImpl).not.toHaveBeenCalled()
  })

  it('uses a targeted npm install command for repair', () => {
    const stateDir = '/tmp/agent-to-wechat-state'
    const result = getDefaultRepairInstallArgs(undefined, stateDir)
    const vendorPath = join(stateDir, 'vendor', 'codex-acp')

    expect(result).toEqual([
      'install',
      '--prefix',
      vendorPath,
      '--no-fund',
      '--no-audit',
      '--no-save',
      '@zed-industries/codex-acp@0.10.0',
    ])
  })

  it('prefers a repaired managed binary under the state directory before PATH', async () => {
    const whichImpl = vi.fn().mockResolvedValueOnce('/tmp/codex').mockResolvedValueOnce(null)
    const validateImpl = vi.fn(async () => undefined)

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        validateImpl,
        repair: false,
        stateDir: '/tmp/agent-to-wechat-state',
        projectRoot: '/repo',
        findManagedPathImpl: vi
          .fn()
          .mockResolvedValueOnce(
            '/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp'
          ),
      })
    ).resolves.toBe('/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp')
  })

  it('falls back to PATH when the managed binary fails validation without repair', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce('/tmp/codex-acp-from-path')
    const validateImpl = vi.fn(async (commandPath: string) => {
      if (
        commandPath === '/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp'
      ) {
        throw new Error('managed launcher failed')
      }
    })

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        validateImpl,
        repair: false,
        stateDir: '/tmp/agent-to-wechat-state',
        projectRoot: EMPTY_PROJECT_ROOT,
        findManagedPathImpl: vi
          .fn()
          .mockResolvedValueOnce(
            '/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp'
          ),
      })
    ).resolves.toBe('/tmp/codex-acp-from-path')
  })

  it('falls back to a repaired PATH binary when the repaired managed binary still fails validation', async () => {
    const whichImpl = vi
      .fn()
      .mockResolvedValueOnce('/tmp/codex')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/tmp/codex-acp-from-path')
    const execInstallImpl = vi.fn(async () => undefined)
    const validateImpl = vi.fn(async (commandPath: string) => {
      if (
        commandPath === '/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp'
      ) {
        throw new Error('managed launcher failed')
      }
    })

    await expect(
      ensureCodexAcpAvailable({
        whichImpl,
        execInstallImpl,
        validateImpl,
        stateDir: '/tmp/agent-to-wechat-state',
        projectRoot: EMPTY_PROJECT_ROOT,
        findManagedPathImpl: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            '/tmp/agent-to-wechat-state/vendor/codex-acp/node_modules/.bin/codex-acp'
          ),
      })
    ).resolves.toBe('/tmp/codex-acp-from-path')
    expect(execInstallImpl).toHaveBeenCalledTimes(1)
  })
})
