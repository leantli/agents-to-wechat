import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const dirPath = dirname(filePath)
  await mkdir(dirPath, { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(dirPath, 0o700)
  await chmod(filePath, 0o600)
}
