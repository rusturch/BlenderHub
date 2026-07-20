// filter tab set is closed (see `filters` memo), so every value has a key here
export const FILTER_LABEL_KEYS: Record<string, string> = {
  all: 'installs.filterAll',
  stable: 'installs.filterStable',
  candidate: 'installs.filterCandidate',
  beta: 'installs.filterBeta',
  alpha: 'installs.filterAlpha',
  experimental: 'installs.filterExperimental'
}
