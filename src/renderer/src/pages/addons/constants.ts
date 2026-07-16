import type { AddonGroupRow, AddonSource } from '../../../../shared/addon-identity'

export const CYCLE_STYLES: Record<string, string> = {
  stable: 'bg-emerald-500/15 text-emerald-400',
  lts: 'bg-emerald-500/15 text-emerald-400',
  candidate: 'bg-purple-500/15 text-purple-400',
  rc: 'bg-purple-500/15 text-purple-400',
  beta: 'bg-sky-500/15 text-sky-400',
  alpha: 'bg-blender/15 text-blender'
}

// source filter tabs, in display order (labels are i18n keys)
export const SOURCE_TABS: { key: AddonSource; labelKey: string }[] = [
  { key: 'user', labelKey: 'addons.tabManual' },
  { key: 'superhive', labelKey: 'addons.tabSuperhive' },
  { key: 'blender_org', labelKey: 'addons.tabBlenderOrg' },
  { key: 'builtin', labelKey: 'addons.tabBuiltin' }
]

// i18n keys per match tier
export const TIER_HINT: Partial<Record<AddonGroupRow['matchTier'], string>> = {
  heuristic: 'addons.tierHeuristic',
  suggested: 'addons.tierSuggested'
}
