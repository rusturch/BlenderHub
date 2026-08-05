import { useEffect, useRef, useState, type RefObject } from 'react'

interface MirrorVScrollbarProps {
  /** the internally-scrolling element this bar mirrors */
  targetRef: RefObject<HTMLElement | null>
  /** placement — the caller positions it (e.g. into the page's scrollbar gutter) */
  className?: string
}

/** A vertical scrollbar rendered OUTSIDE its target: the target hides its own inset
 *  native bar (`.no-native-v-scrollbar` in main.css) and this mirror sits where the
 *  caller puts it — on Add-ons, in the page's reserved scrollbar gutter, so the
 *  internally-scrolling table reads exactly like a page-scrolling list (Installs).
 *  It is a real scroll container, so the auto-hide behavior (lib/scrollbar.ts) and
 *  the thumb styling (main.css) apply to it unchanged. Size it to the target's
 *  CLIENT box (inside the borders): scroll positions sync 1:1, so equal client
 *  heights are what make both ends of the ranges line up exactly. */
export default function MirrorVScrollbar({ targetRef, className = '' }: MirrorVScrollbarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [scrollHeight, setScrollHeight] = useState(0)
  const [clientHeight, setClientHeight] = useState(0)
  // the last position this component wrote into the bar, so the scroll event that write
  // provokes can be told apart from one the user caused
  const echoRef = useRef(Number.NaN)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const measure = () => {
      setScrollHeight(target.scrollHeight)
      setClientHeight(target.clientHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    // content can grow/shrink (rows expanding) without the container resizing
    if (target.firstElementChild) observer.observe(target.firstElementChild)
    return () => observer.disconnect()
  }, [targetRef])

  const barVisible = scrollHeight > clientHeight

  // the bar only exists in the DOM once barVisible flips true, so the scroll-sync
  // listeners must (re-)attach then too — not just once on mount
  useEffect(() => {
    const target = targetRef.current
    const bar = barRef.current
    if (!target || !bar) return
    // Scroll events are delivered asynchronously, so a flag raised and dropped around the
    // write below is already down by the time the write's own event arrives. Matching on
    // the value instead is what makes the echo recognisable — and that matters beyond
    // tidiness: writing scrollTop cancels an in-progress smooth scroll, so an unfiltered
    // echo would kill "back to top" the moment its animation moved a single frame.
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1
    const followTarget = () => {
      if (near(bar.scrollTop, target.scrollTop)) return
      echoRef.current = target.scrollTop
      bar.scrollTop = echoRef.current
    }
    const followBar = () => {
      if (near(bar.scrollTop, echoRef.current)) return // our own write coming back
      if (near(target.scrollTop, bar.scrollTop)) return
      target.scrollTop = bar.scrollTop
    }
    followTarget()
    target.addEventListener('scroll', followTarget, { passive: true })
    bar.addEventListener('scroll', followBar, { passive: true })
    return () => {
      target.removeEventListener('scroll', followTarget)
      bar.removeEventListener('scroll', followBar)
    }
  }, [targetRef, barVisible])

  if (!barVisible) return null

  return (
    <div ref={barRef} className={`overflow-y-auto overflow-x-hidden ${className}`}>
      <div style={{ height: scrollHeight, width: 1 }} />
    </div>
  )
}
