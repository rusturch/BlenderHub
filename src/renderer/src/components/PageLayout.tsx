import type { ReactNode } from 'react'

interface PageLayoutProps {
  title: string
  actions?: ReactNode
  children: ReactNode
}

export default function PageLayout({ title, actions, children }: PageLayoutProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/5 px-6">
        <h1 className="text-base font-semibold text-zinc-100">{title}</h1>
        {actions}
      </header>
      {/* right padding is 24px minus the 10px scrollbar gutter, so both sides read equal */}
      <div className="flex-1 overflow-y-auto pt-4 pb-6 pl-6 pr-3.5 [scrollbar-gutter:stable]">{children}</div>
    </div>
  )
}

interface EmptyStateProps {
  icon: ReactNode
  title: string
  hint: string
}

export function EmptyState({ icon, title, hint }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 text-zinc-500">
        {icon}
      </div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-zinc-500">{hint}</p>
    </div>
  )
}
