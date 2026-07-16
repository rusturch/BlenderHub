import { SYNC_COMPONENT_IDS } from '../../../../shared/types'
import type { SyncComponentId, SyncOpResult, SyncVersionColumn } from '../../../../shared/types'
import type { Translate } from './types'
import { COMPONENT_ROWS } from './constants'

// component ids and minors never contain spaces, so a space is a safe key separator
export const PENDING_SEP = ' '
export const cellKey = (minor: string, id: SyncComponentId): string => `${minor}${PENDING_SEP}${id}`

export function labelOf(component: SyncOpResult['component'], t: Translate): string {
  if (component === 'addons-fixup') return t('sync.enabledAddonsLabel')
  if (component === 'backup') return t('sync.backupLabel')
  if (component === 'recent') return t('sync.recentFilesLabel') // parked — only old backups mention it
  const row = COMPONENT_ROWS.find((candidate) => candidate.id === component)
  return row ? t(row.labelKey) : component
}

export const hasAnySettings = (column: SyncVersionColumn): boolean =>
  SYNC_COMPONENT_IDS.some((id) => column.components[id]?.present)
