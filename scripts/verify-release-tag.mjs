import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function stripTagPrefix(tag) {
  const match = /^v(.+)$/.exec(tag)
  return match ? match[1] : null
}

export function verifyReleaseTag(tag, packageVersion) {
  const normalizedTag = stripTagPrefix(tag)

  if (!normalizedTag) {
    throw new Error(`Release tag must start with v: ${tag}`)
  }

  if (!packageVersion) {
    throw new Error('package.json version is missing')
  }

  if (normalizedTag !== packageVersion) {
    throw new Error(
      `Release tag ${tag} does not match package.json version ${packageVersion}`
    )
  }

  return packageVersion
}

function main(argv = process.argv.slice(2)) {
  const [tagArg] = argv
  const projectRoot = process.cwd()
  const pkg = readJson(resolve(projectRoot, 'package.json'))
  const tag = tagArg ?? process.env.GITHUB_REF_NAME ?? ''

  verifyReleaseTag(tag, pkg.version)
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
