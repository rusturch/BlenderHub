const PLATFORM_BY_NODE: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' }
const ARCH_ALIASES: Record<string, string[]> = { x64: ['amd64', 'x86_64'], arm64: ['arm64'] }

export function getCurrentTarget(): { platform: string; architectures: string[] } {
  return {
    platform: PLATFORM_BY_NODE[process.platform] ?? process.platform,
    architectures: ARCH_ALIASES[process.arch] ?? [process.arch]
  }
}
