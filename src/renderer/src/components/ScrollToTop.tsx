import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from '../lib/i18n'

// far enough down that scrolling back by hand is a chore, near enough that the button
// is already there when it starts to feel like one
const REVEAL_AFTER_PX = 200

// The trip home takes this long from anywhere. scrollTo({behavior:'smooth'}) instead
// paces itself by distance, so the longer the list the longer the wait — the opposite of
// what a shortcut should do.
const TRAVEL_MS = 260

function ArrowUpIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

/**
 * Floating "back to top" for a scrollable element — pass the ref of whatever actually
 * scrolls. Most pages hand it PageLayout's own scroll area; a page whose list scrolls
 * inside a card (Add-ons) hands it that card instead. Positions itself absolutely, so
 * the nearest positioned ancestor decides which corner it hangs in.
 */
export default function ScrollToTop({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const frameRef = useRef(0)

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  const travelHome = (): void => {
    const element = targetRef.current
    if (!element) return
    cancelAnimationFrame(frameRef.current) // a second click restarts rather than races
    const from = element.scrollTop
    if (from === 0) return
    const startedAt = performance.now()
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / TRAVEL_MS)
      const eased = 1 - (1 - progress) ** 3 // ease-out: brisk away, settles at the top
      element.scrollTop = from * (1 - eased)
      if (progress < 1) frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
  }

  // Listening on the document's capture phase rather than on the element itself: scroll
  // events do not bubble, but they do capture down, and the target is read at event time.
  // That matters when the scrolling element appears later than this button — Add-ons only
  // renders its table once a scan has produced data.
  useEffect(() => {
    const onScroll = (event: Event): void => {
      const element = targetRef.current
      if (!element || event.target !== element) return
      setVisible(element.scrollTop > REVEAL_AFTER_PX)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [targetRef])

  return (
    <button
      type="button"
      onClick={travelHome}
      title={t('common.scrollToTop')}
      // hidden state keeps it out of the tab order and lets clicks through to the list
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      // brightness, not a bg-white/10 overlay: this button's background is opaque, and a
      // translucent hover colour REPLACES it rather than layering over it — the list would
      // show straight through the button
      className={`absolute bottom-3 right-3 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-surface-menu text-icon shadow-lg shadow-black/40 transition hover:brightness-125 hover:text-icon-hover ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <ArrowUpIcon className="h-4 w-4" />
    </button>
  )
}
