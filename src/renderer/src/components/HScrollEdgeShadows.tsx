import { useEffect, useState, type RefObject } from 'react'

interface HScrollEdgeShadowsProps {
  /** the horizontally-scrollable element to watch */
  targetRef: RefObject<HTMLElement | null>
  /** a sticky first column inside the target — the left shadow starts at its right edge */
  stickyRef?: RefObject<HTMLElement | null>
  /** gap left un-dimmed at the bottom, e.g. the height of a native horizontal scrollbar */
  bottomInset?: number
}

/** Gradient shadows over the edges of a horizontally-scrollable container, shown only
 *  while more columns are actually hidden in that direction. Render inside a
 *  `position: relative` wrapper around the scroll container.
 *
 *  Each side is TWO stacked bands split at the sticky header's bottom edge, not one
 *  full-height gradient. The z-order requirements are circular for a single band:
 *  the shadow must dim the sticky header (its version labels cut off like the cells),
 *  the header must mask row-divider overlays scrolling under it (z-11), and those
 *  overlays must stay visible over the shadow. Splitting by geometry makes the order
 *  linear: header band z-30 > header cells z-20 > divider overlays z-11 > body band
 *  z-10 > plain cell content. The two bands share one gradient, so the seam is
 *  invisible; with no sticky header (headerRef height 0) they fuse into the old look. */
export default function HScrollEdgeShadows({ targetRef, stickyRef, bottomInset = 10 }: HScrollEdgeShadowsProps) {
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const [leftInset, setLeftInset] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(0)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const update = () => {
      // 2px tolerance: fractional display scaling (e.g. Windows 125%) can leave scrollLeft
      // a hair short of its true maximum even at the end of the range
      setCanLeft(target.scrollLeft > 2)
      setCanRight(target.scrollLeft + target.clientWidth < target.scrollWidth - 2)
      setLeftInset(stickyRef?.current?.getBoundingClientRect().width ?? 0)
      setHeaderHeight(stickyRef?.current?.getBoundingClientRect().height ?? 0)
    }
    update()
    target.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(target)
    // content (the table) can grow/shrink without the container resizing
    if (target.firstElementChild) observer.observe(target.firstElementChild)
    return () => {
      target.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [targetRef, stickyRef])

  const band = (side: 'left' | 'right', part: 'header' | 'body', visible: boolean) => {
    const gradient = side === 'left' ? 'bg-gradient-to-r' : 'bg-gradient-to-l'
    const layer = part === 'header' ? 'z-30' : 'z-10'
    // the container is rounded-xl — round whichever of its right corners a band can reach
    const rounding = side === 'right' ? (part === 'header' ? 'rounded-tr-xl' : 'rounded-br-xl') : ''
    return (
      <div
        aria-hidden
        className={`pointer-events-none absolute w-10 ${gradient} from-scroll-shadow to-transparent transition-opacity duration-200 ${layer} ${rounding} ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          left: side === 'left' ? leftInset : undefined,
          right: side === 'right' ? 0 : undefined,
          top: part === 'header' ? 0 : headerHeight,
          height: part === 'header' ? headerHeight : undefined,
          bottom: part === 'body' ? bottomInset : undefined
        }}
      />
    )
  }

  return (
    <>
      {band('left', 'header', canLeft)}
      {band('left', 'body', canLeft)}
      {band('right', 'header', canRight)}
      {band('right', 'body', canRight)}
    </>
  )
}
