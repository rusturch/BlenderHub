import { uiGet } from '../../lib/ui-store'

export const readFlag = (key: string, fallback: boolean): boolean => {
  const stored = uiGet(key)
  return stored === null ? fallback : stored === '1'
}

// last path segment — the renderer has no node "path" module
export const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path
