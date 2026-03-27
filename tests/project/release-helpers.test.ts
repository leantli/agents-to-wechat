import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('release helpers', () => {
  it('accepts the current package version tag and rejects mismatches', async () => {
    const { verifyReleaseTag } = await import('../../scripts/verify-release-tag.mjs')
    const pkg = JSON.parse(readText(resolve(projectRoot, 'package.json'))) as {
      version?: string
    }

    expect(() => verifyReleaseTag(`v${pkg.version}`, pkg.version)).not.toThrow()
    expect(() => verifyReleaseTag('v999.999.999', pkg.version)).toThrow(
      'does not match package.json version'
    )
  })

  it('extracts the matching changelog entry', async () => {
    const { extractChangelogEntry } = await import('../../scripts/extract-changelog-entry.mjs')
    const changelog = readText(resolve(projectRoot, 'CHANGELOG.md'))
    const pkg = JSON.parse(readText(resolve(projectRoot, 'package.json'))) as {
      version?: string
    }
    const version = pkg.version ?? ''

    const entryFromTag = extractChangelogEntry(changelog, `v${version}`)
    const entryFromVersion = extractChangelogEntry(changelog, version)

    expect(entryFromTag).toBe(entryFromVersion)
    expect(entryFromTag).toContain(`## [${version}]`)
    expect(entryFromTag.length).toBeGreaterThan(`## [${version}]`.length)
  })

  it('extracts entries from Changesets-style changelog headings', async () => {
    const { extractChangelogEntry } = await import('../../scripts/extract-changelog-entry.mjs')
    const changelog = `# Changelog

## 0.1.1

- Follow-up release

## 0.1.0

- Initial release
`

    const entry = extractChangelogEntry(changelog, 'v0.1.1')

    expect(entry).toContain('## 0.1.1')
    expect(entry).toContain('Follow-up release')
    expect(entry).not.toContain('## 0.1.0')
  })
})
