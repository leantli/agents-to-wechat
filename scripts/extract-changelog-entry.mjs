import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function readText(path) {
  return readFileSync(path, 'utf8')
}

function normalizeVersion(versionOrTag) {
  const match = /^v(.+)$/.exec(versionOrTag)
  return match ? match[1] : versionOrTag
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isVersionHeading(line, version) {
  const normalizedLine = line.trim()
  const escapedVersion = escapeRegExp(version)
  const headingPattern = new RegExp(
    `^##\\s+\\[?${escapedVersion}\\]?(?:\\s+-\\s+.+)?$`
  )

  return headingPattern.test(normalizedLine)
}

export function extractChangelogEntry(changelogText, versionOrTag) {
  const version = normalizeVersion(versionOrTag)
  const lines = changelogText.split(/\r?\n/)
  const startIndex = lines.findIndex((line) => isVersionHeading(line, version))

  if (startIndex === -1) {
    throw new Error(`Changelog entry not found for version ${version}`)
  }

  let endIndex = lines.length

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      endIndex = index
      break
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').trimEnd()
}

function main(argv = process.argv.slice(2)) {
  const [versionArg] = argv
  const projectRoot = process.cwd()
  const changelog = readText(resolve(projectRoot, 'CHANGELOG.md'))
  const version = versionArg ?? process.env.GITHUB_REF_NAME ?? ''

  process.stdout.write(`${extractChangelogEntry(changelog, version)}\n`)
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectExecution) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
