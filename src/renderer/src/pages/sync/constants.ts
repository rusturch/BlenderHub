import type { SyncApplyPhase, SyncComponentId } from '../../../../shared/types'
import type { CellFace } from './types'

export const CYCLE_STYLES: Record<string, string> = {
  stable: 'bg-emerald-500/15 text-emerald-400',
  lts: 'bg-emerald-500/15 text-emerald-400',
  candidate: 'bg-purple-500/15 text-purple-400',
  rc: 'bg-purple-500/15 text-purple-400',
  beta: 'bg-sky-500/15 text-sky-400',
  alpha: 'bg-blender/15 text-blender'
}

// 'recent' is deliberately absent: parked for now (churns every session), see
// HIDDEN_SYNC_COMPONENT_IDS in shared/types.ts
export const COMPONENT_ROWS: { id: SyncComponentId; labelKey: string; hintKey: string }[] = [
  { id: 'preferences', labelKey: 'sync.componentPreferences', hintKey: 'sync.componentPreferencesHint' },
  { id: 'startup', labelKey: 'sync.componentStartup', hintKey: 'sync.componentStartupHint' },
  { id: 'bookmarks', labelKey: 'sync.componentBookmarks', hintKey: 'sync.componentBookmarksHint' },
  { id: 'presets', labelKey: 'sync.componentPresets', hintKey: 'sync.componentPresetsHint' },
  { id: 'scripts', labelKey: 'sync.componentScripts', hintKey: 'sync.componentScriptsHint' },
  { id: 'datafiles', labelKey: 'sync.componentDatafiles', hintKey: 'sync.componentDatafilesHint' }
]

export const PHASE_LABEL_KEYS: Record<SyncApplyPhase, string> = {
  backup: 'sync.phaseBackup',
  copying: 'sync.phaseCopying',
  fixup: 'sync.phaseFixup',
  done: 'sync.phaseDone',
  error: 'sync.phaseError'
}

export const FACE_DOT: Record<CellFace, string> = {
  push: 'bg-amber-400',
  new: 'bg-amber-400',
  unlink: 'border-2 border-amber-400',
  sourceChanged: 'bg-amber-400',
  inSync: 'bg-emerald-400',
  targetChanged: 'bg-sky-400',
  conflict: 'bg-red-400'
}

export const FACE_TITLE_KEYS: Record<CellFace, string> = {
  push: 'sync.faceTitlePush',
  new: 'sync.faceTitleNew',
  unlink: 'sync.faceTitleUnlink',
  sourceChanged: 'sync.faceTitleSourceChanged',
  inSync: 'sync.faceTitleInSync',
  targetChanged: 'sync.faceTitleTargetChanged',
  conflict: 'sync.faceTitleConflict'
}
