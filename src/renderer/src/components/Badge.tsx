import type { ReactNode } from 'react'

// Blender release-cycle → pill colors. One copy for the whole app — Installs, Add-ons and
// Sync all render the same cycle chips; lts aliases stable, rc aliases candidate.
export const CYCLE_STYLES: Record<string, string> = {
  stable: 'bg-emerald-500/15 text-emerald-400',
  lts: 'bg-emerald-500/15 text-emerald-400',
  candidate: 'bg-purple-500/15 text-purple-400',
  rc: 'bg-purple-500/15 text-purple-400',
  beta: 'bg-sky-500/15 text-sky-400',
  alpha: 'bg-[var(--blender-brand)]/15 text-[var(--blender-brand)]'
}

// widest cycle word above — the sample a BadgeSlot reserves so a text-sized chip still
// leaves room for the longest one that could sit in its place. Never translated.
export const LONGEST_CYCLE = 'candidate'

const DEFAULT_TONE = 'bg-white/10 text-zinc-400'

export type BadgeSize = 'md' | 'sm'
const SIZE_CLASS: Record<BadgeSize, string> = { md: 'text-[10px]', sm: 'text-[9px]' }

/**
 * A pill whose colored background hugs its text — width follows content, never a fixed
 * column. When something after the badge (a chip) or beside it (a table column) must stay
 * aligned across rows, wrap it in <BadgeSlot> rather than padding the pill itself.
 */
export function Badge({
  tone,
  size = 'md',
  className = '',
  children
}: {
  tone?: string
  size?: BadgeSize
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${SIZE_CLASS[size]} ${tone ?? DEFAULT_TONE} ${className}`}
    >
      {children}
    </span>
  )
}

/** A cycle chip — Badge with the color looked up from the cycle name. */
export function CycleBadge({ cycle, size = 'md' }: { cycle: string; size?: BadgeSize }) {
  return (
    <Badge tone={CYCLE_STYLES[cycle] ?? DEFAULT_TONE} size={size}>
      {cycle}
    </Badge>
  )
}

/**
 * Reserves a fixed width for a text-sized badge so what follows it (a project chip in
 * Installs) or sits beside it (even columns in Add-ons/Sync) stays aligned, while the
 * visible pill still hugs its own text. `measure` is the widest label the slot must ever
 * hold — pass an array when more than one string can appear here; `align` places the real
 * badge within the reserved box (left for a row, center for a column header).
 */
export function BadgeSlot({
  measure,
  align = 'start',
  size = 'md',
  children
}: {
  measure: ReactNode | ReactNode[]
  align?: 'start' | 'center'
  size?: BadgeSize
  children: ReactNode
}) {
  const samples = Array.isArray(measure) ? measure : [measure]
  return (
    <span
      className={`grid shrink-0 ${align === 'center' ? 'justify-items-center' : 'justify-items-start'}`}
    >
      {samples.map((sample, index) => (
        <Badge key={index} size={size} className="invisible col-start-1 row-start-1">
          {sample}
        </Badge>
      ))}
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  )
}
