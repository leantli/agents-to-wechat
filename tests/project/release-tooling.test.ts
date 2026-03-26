import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCli, readPackageVersion } from '../../src/cli.js'

const projectRoot = resolve(import.meta.dirname, '../..')

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('release tooling', () => {
  it('keeps release surfaces aligned with the package version', () => {
    const pkg = JSON.parse(readText(resolve(projectRoot, 'package.json'))) as {
      version?: string
      scripts?: Record<string, string>
    }
    const lock = JSON.parse(readText(resolve(projectRoot, 'package-lock.json'))) as {
      version?: string
      packages?: Record<string, { version?: string }>
    }
    const changelog = readText(resolve(projectRoot, 'CHANGELOG.md'))
    const readmeEn = readText(resolve(projectRoot, 'README_EN.md'))
    const version = pkg.version
    const versionPackages = pkg.scripts?.['version-packages']

    expect(version).toBeTruthy()
    expect(lock.version).toBe(version)
    expect(lock.packages?.['']?.version).toBe(version)
    expect(readPackageVersion()).toBe(version)
    expect(buildCli().version()).toBe(version)
    expect(versionPackages).toContain('changeset version')
    expect(versionPackages).toContain('npm install --package-lock-only')
    expect(changelog).toContain(`## [${version}]`)
    expect(changelog).not.toContain('0.1.3-alpha')
    expect(readmeEn).toContain('agents-to-wechat')
    expect(existsSync(resolve(projectRoot, '.changeset/initial-release.md'))).toBe(false)
  })

  it('defines a complete release preflight gate', () => {
    const pkg = JSON.parse(readText(resolve(projectRoot, 'package.json'))) as {
      scripts?: Record<string, string>
    }
    const preflight = pkg.scripts?.['release:preflight']

    expect(preflight).toContain('npm run format:check')
    expect(preflight).toContain('npm run build')
    expect(preflight).toContain('npm pack --dry-run')
    expect(preflight).toContain('node dist/index.js --help')
    expect(preflight).toContain('node dist/index.js doctor --help')
  })

  it('publishes to npm through the NPM_TOKEN GitHub secret', () => {
    const workflow = readText(resolve(projectRoot, '.github/workflows/release.yml'))

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('npm publish --access public --provenance')
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(workflow).not.toContain('Trusted Publishing')
  })
})
