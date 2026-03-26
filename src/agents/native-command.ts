export function extractNativeCommandName(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }

  const firstToken = trimmed.split(/\s+/, 1)[0]
  return firstToken && firstToken.startsWith('/') ? firstToken : null
}
