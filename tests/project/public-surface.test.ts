import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('public surface', () => {
  it('keeps the package and docs aligned with the new release identity', () => {
    const pkg = JSON.parse(readText(resolve(projectRoot, 'package.json'))) as {
      name?: string
      bin?: Record<string, string>
      files?: string[]
    }
    const readme = readText(resolve(projectRoot, 'README.md'))
    const contributing = readText(resolve(projectRoot, 'CONTRIBUTING.md'))
    const gitignore = readText(resolve(projectRoot, '.gitignore'))

    expect(pkg.name).toBe('agents-to-wechat')
    expect(pkg.bin?.['agents-to-wechat']).toBe('./dist/index.js')
    expect(pkg.files).toContain('dist')
    expect(pkg.files).toContain('README.md')
    expect(pkg.files).toContain('LICENSE')
    expect(readme).toContain('npm install -g agents-to-wechat')
    expect(readme).toContain('npx agents-to-wechat start')
    expect(readme).toContain('npm run build')
    expect(readme).toContain('npm link')
    expect(readme.indexOf('npm run build')).toBeLessThan(readme.indexOf('npm link'))
    expect(readme).not.toContain('github.com/leantli/agent-to-wechat')
    expect(contributing).not.toContain('github.com/leantli/agent-to-wechat')
    expect(contributing).toContain('NPM_TOKEN')
    expect(contributing).not.toContain('Trusted Publishing')
    expect(contributing).toContain('npm run version-packages')
    expect(readme).not.toContain('codecov')
    expect(readme).not.toContain('version-v0.1.0--alpha')
    expect(gitignore).toContain('package/')
    expect(existsSync(resolve(projectRoot, '.npmignore'))).toBe(false)
  })
})
