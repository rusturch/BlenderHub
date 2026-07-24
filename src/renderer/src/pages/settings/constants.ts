import type { StorageCategory } from '../../../../shared/types'


export const SUPERHIVE_DOCS_URL = 'https://superhivemarket.com/account/auth_token'

export const pathBoxClass =
  'min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-surface-input px-3 py-1.5 text-xs text-zinc-300'
export const secondaryButtonClass =
  'shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10'
export const primaryButtonClass =
  'shrink-0 rounded-lg bg-accent-button px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40'

// per-category label + color for the storage breakdown bar and legend
export const STORAGE_META: Record<StorageCategory, { labelKey: string; color: string }> = {
  installs: { labelKey: 'settings.storageInstalls', color: 'bg-[var(--blender-brand)]' },
  downloads: { labelKey: 'settings.storageDownloads', color: 'bg-sky-500' },
  library: { labelKey: 'settings.storageLibrary', color: 'bg-emerald-500' },
  backups: { labelKey: 'settings.storageBackups', color: 'bg-violet-500' },
  other: { labelKey: 'settings.storageOther', color: 'bg-zinc-500' }
}
