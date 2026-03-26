#!/usr/bin/env node

import { buildCli } from './cli.js'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'

export async function run(argv = process.argv): Promise<void> {
  await buildCli().parseAsync(argv, { from: 'node' })
}

export async function main(
  input: {
    argv?: string[]
    runImpl?: (argv?: string[]) => Promise<void>
    stderr?: Pick<NodeJS.WriteStream, 'write'>
    exit?: (code: number) => never | void
  } = {}
): Promise<void> {
  const runImpl = input.runImpl ?? run
  const argv = input.argv ?? process.argv
  const stderr = input.stderr ?? process.stderr
  const exitFn = input.exit ?? process.exit.bind(process)

  try {
    await runImpl(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`${message}\n`)
    exitFn(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main()
}
