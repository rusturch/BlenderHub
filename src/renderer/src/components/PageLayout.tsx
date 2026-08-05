import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import ScrollToTop from './ScrollToTop'

interface PageLayoutProps {
  title: string
  actions?: ReactNode
  children: ReactNode
  /**
   * The element that actually scrolls, for a page whose list lives in a card of its own
   * rather than in the area below (Add-ons). The back-to-top button still hangs in this
   * layout's corner, so it sits in the same place on every tab — only its target differs.
   */
  scrollTargetRef?: RefObject<HTMLElement | null>
}

export default function PageLayout({ title, actions, children, scrollTargetRef }: PageLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div className="relative flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/5 px-6">
        <h1 className="text-base font-semibold text-zinc-100">{title}</h1>
        {actions}
      </header>
      {/* right padding is 24px minus the 10px scrollbar gutter, so both sides read equal */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto pt-4 pb-6 pl-6 pr-3.5 [scrollbar-gutter:stable]"
      >
        {children}
      </div>
      <ScrollToTop targetRef={scrollTargetRef ?? scrollRef} />
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
