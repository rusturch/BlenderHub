// filter tab set is closed (see `filters` memo), so every value has a key here
export const FILTER_LABEL_KEYS: Record<string, string> = {
  all: 'installs.filterAll',
  stable: 'installs.filterStable',
  candidate: 'installs.filterCandidate',
  rc: 'installs.filterRc',
  beta: 'installs.filterBeta',
  alpha: 'installs.filterAlpha',
  experimental: 'installs.filterExperimental',
  archive: 'installs.filterArchive'
}
export const CYCLE_STYLES: Record<string, string> = {
  stable: 'bg-emerald-500/15 text-emerald-400',
  lts: 'bg-emerald-500/15 text-emerald-400',
  candidate: 'bg-purple-500/15 text-purple-400',
  rc: 'bg-purple-500/15 text-purple-400',
  beta: 'bg-sky-500/15 text-sky-400',
  alpha: 'bg-blender/15 text-blender'
}
