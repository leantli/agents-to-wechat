import { AppConfigSchema, type AppConfig } from './schema.js'
import { getStateDir } from '../storage/paths.js'

export type LoadConfigInput = Partial<{
  wechat: Partial<AppConfig['wechat']>
  agent: Partial<AppConfig['agent']>
  storage: Partial<AppConfig['storage']>
}>

export function loadConfig(input: LoadConfigInput): AppConfig {
  return AppConfigSchema.parse({
    wechat: input.wechat ?? {},
    agent: input.agent ?? {},
    storage: {
      stateDir: getStateDir(input.storage?.stateDir),
    },
  })
}
