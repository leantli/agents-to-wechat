import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { runDoctor } from './commands/doctor.js'
import { runLogout } from './commands/logout.js'
import { runLogin } from './commands/login.js'
import { runStart } from './commands/start.js'

interface CommandOptions {
  baseUrl?: string
  stateDir?: string
}

export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string
  }

  if (!pkg.version) {
    throw new Error('package.json version is missing')
  }

  return pkg.version
}

export function buildCli(): Command {
  const program = new Command()
    .name('agents-to-wechat')
    .version(readPackageVersion())
    .description('Connect Codex agent to WeChat private chats')

  program
    .command('login')
    .description('Log in to WeChat and save credentials')
    .option('--base-url <url>', 'WeChat API base URL (for testing)')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (options: CommandOptions) => {
      await runLogin({
        baseUrl: options.baseUrl,
        stateDir: options.stateDir,
      })
    })

  program
    .command('start')
    .description('Start the WeChat-Codex bridge service')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (options: CommandOptions) => {
      await runStart({ stateDir: options.stateDir })
    })

  program
    .command('doctor')
    .description('Check system requirements and configuration')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (options: CommandOptions) => {
      await runDoctor({ stateDir: options.stateDir })
    })

  program
    .command('logout')
    .description('Remove saved WeChat credentials and sync state')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (options: CommandOptions) => {
      await runLogout({ stateDir: options.stateDir })
    })

  return program
}
