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
  const syncingRef = useRef(false)

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
    const followTarget = () => {
      if (syncingRef.current) return
      syncingRef.current = true
      bar.scrollTop = target.scrollTop
      syncingRef.current = false
    }
    const followBar = () => {
      if (syncingRef.current) return
      syncingRef.current = true
      target.scrollTop = bar.scrollTop
      syncingRef.current = false
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
