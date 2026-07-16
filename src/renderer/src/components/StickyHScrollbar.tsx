import { useEffect, useRef, useState, type RefObject } from 'react'

interface StickyHScrollbarProps {
  /** the wide, horizontally-scrollable element this bar mirrors */
  targetRef: RefObject<HTMLElement | null>
  className?: string
  /**
   * 'fixed' (default) — pinned to the bottom of the viewport, shown only while the target's
   * own native bar is below the fold; for wide tables on tall, page-scrolling lists.
   * 'attached' — rendered in normal flow right where the component sits (put it just below
   * the target), shown whenever the target overflows; for a target that bounds its own
   * height, whose native bar would sit inset inside the panel's rounded border — the caller
   * hides that native bar (`.no-native-h-scrollbar` in main.css) and this replaces it.
   */
  variant?: 'fixed' | 'attached'
}

/** A thin scrollbar that mirrors `targetRef`'s horizontal scroll (see `variant`).
 *  The fixed variant uses `position: fixed` (tracking the target's rect) rather than
 *  `sticky; bottom` — Chromium's sticky-bottom does not engage when the element sits
 *  ahead of a much taller sibling instead of trailing it. */
export default function StickyHScrollbar({ targetRef, className = '', variant = 'fixed' }: StickyHScrollbarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [scrollWidth, setScrollWidth] = useState(0)
  const [clientWidth, setClientWidth] = useState(0)
  const [rect, setRect] = useState({ left: 0, width: 0 })
  // the target's own native scrollbar sits at its bottom edge — once that edge has
  // scrolled into view, the real thing is reachable and this overlay just doubles up
  const [nativeBarInView, setNativeBarInView] = useState(false)
  const syncingRef = useRef(false)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const measure = () => {
      setScrollWidth(target.scrollWidth)
      setClientWidth(target.clientWidth)
      const box = target.getBoundingClientRect()
      setRect({ left: box.left, width: box.width })
      setNativeBarInView(box.bottom <= window.innerHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    // ResizeObserver only fires on size changes — scrolling the page moves the
    // target's rect without resizing it, so its own scrolling ancestor needs a
    // listener too (falls back to window if that ancestor can't be found).
    // Search from the PARENT, not the target itself: a target that bounds its own
    // height carries this same `.overflow-y-auto` class, and `closest()` matches
    // the element itself first — which would make this track the target's OWN
    // internal scroll instead of an outer page-scroll ancestor.
    const scrollAncestor = target.parentElement?.closest('.overflow-y-auto') ?? window
    scrollAncestor.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      scrollAncestor.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [targetRef])

  const barVisible = scrollWidth > clientWidth && (variant === 'attached' || !nativeBarInView)

  // the bar only exists in the DOM once barVisible flips true, so the scroll-sync
  // listeners must (re-)attach then too — not just once on mount
  useEffect(() => {
    const target = targetRef.current
    const bar = barRef.current
    if (!target || !bar) return
    const followTarget = () => {
      if (syncingRef.current) return
      syncingRef.current = true
      bar.scrollLeft = target.scrollLeft
      syncingRef.current = false
    }
    const followBar = () => {
      if (syncingRef.current) return
      syncingRef.current = true
      target.scrollLeft = bar.scrollLeft
      syncingRef.current = false
    }
    target.addEventListener('scroll', followTarget, { passive: true })
    bar.addEventListener('scroll', followBar, { passive: true })
    return () => {
      target.removeEventListener('scroll', followTarget)
      bar.removeEventListener('scroll', followBar)
    }
  }, [targetRef, barVisible])

  if (!barVisible) return null

  // px-px: the bar spans the target's BORDER box, but scrolling happens in its CLIENT box
  // (inside 1px borders). Scroll positions sync 1:1, so the bar's client width must equal
  // the target's — otherwise dragging the bar to its end leaves the target 2px short of
  // its own end (and the edge shadow correctly, but confusingly, stays on).
  if (variant === 'attached') {
    return (
      <div className={`px-px pt-1.5 ${className}`}>
        <div ref={barRef} className="h-2.5 overflow-x-auto overflow-y-hidden">
          <div style={{ width: scrollWidth, height: 1 }} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={`fixed bottom-0 z-20 bg-[#0d0d0d] px-px py-1.5 ${className}`}
      style={{ left: rect.left, width: rect.width }}
    >
      <div ref={barRef} className="h-2.5 overflow-x-auto overflow-y-hidden">
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>
    </div>
  )
}
