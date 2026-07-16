import { uiGet } from '../../lib/ui-store'

export const readFlag = (key: string, fallback: boolean): boolean => {
  const stored = uiGet(key)
  return stored === null ? fallback : stored === '1'
}
