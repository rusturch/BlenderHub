import type { AddonGroupRow, AddonSource } from '../../../../shared/addon-identity'

// A sample that rides invisibly in the header cells so the version columns come out even
// whatever the gear menu has switched on — each cell is only as wide as its own content,
// so without it a longer version outgrows its neighbours. Manrope's figures are
// proportional, so the use sites pair this with tabular-nums; that is what lets one 8
// stand in for any digit. (The cycle badge reserves its own width via BadgeSlot.)
export const WIDEST_MINOR = '8.88' // Blender minors run to four characters (2.93)

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
