import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8
const GAP = 4

interface DropdownProps {
  open: boolean
  onClose: () => void
  /** the clickable trigger; its own onClick toggles `open` */
  trigger: ReactNode
  children: ReactNode
  /** which edge of the menu lines up with the trigger; default 'right' */
  align?: 'left' | 'right'
  /** visual classes for the menu box (no positioning — that is handled here) */
  menuClassName?: string
  /** extra classes for the anchor wrapper (e.g. ml-auto, absolute positioning) */
  className?: string
  /**
   * Viewport point to open at instead of under the trigger — for context menus, which
   * belong at the cursor. The trigger still anchors dismissal, so a click on it closes
   * the menu as usual.
   */
  at?: { x: number; y: number } | null
}

// The menu is rendered in a portal with fixed positioning so it is never clipped
// by a scroll container, the sidebar, or the window edges. It opens below the
// trigger, flips above when there is no room, and shifts to stay on screen.
export default function Dropdown({
  open,
  onClose,
  trigger,
  children,
  align = 'right',
  menuClassName = '',
  className = '',
  at = null
}: DropdownProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  return (
    <span ref={anchorRef} className={`inline-flex ${className}`}>
      {trigger}
      {open && (
        <DropdownMenu
          anchorRef={anchorRef}
          onClose={onClose}
          align={align}
          className={menuClassName}
          at={at}
        >
          {children}
        </DropdownMenu>
      )}
    </span>
  )
}

function DropdownMenu({
  anchorRef,
  onClose,
  align,
  className,
  at,
  children
}: {
  anchorRef: RefObject<HTMLSpanElement | null>
  onClose: () => void
  align: 'left' | 'right'
  className: string
  at: { x: number; y: number } | null
  children: ReactNode
}): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: 0,
    left: 0,
    visibility: 'hidden'
  })

  // No dep array: the anchor can move without scroll or resize firing (e.g. a background
  // rescan reorders the grid behind an open menu), but that always re-renders the menu,
  // so recomputing on every commit keeps it glued to its trigger. The functional setState
  // bails out when the position is unchanged, so this does not render-loop.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!menu || (!anchor && !at)) return
    // a cursor point behaves like a zero-size anchor: the flip/clamp rules below then
    // place the menu at it exactly the way they place one under a trigger
    const a = at
      ? { top: at.y, bottom: at.y, left: at.x, right: at.x }
      : anchor!.getBoundingClientRect()
    const m = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // prefer below the trigger; flip above only if it does not fit below but fits above
    let top = a.bottom + GAP
    if (top + m.height > vh - MARGIN && a.top - GAP - m.height >= MARGIN) {
      top = a.top - GAP - m.height
    }
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - m.height))

    // right-aligned: menu right edge meets the trigger right edge; then clamp to the viewport
    let left = align === 'right' ? a.right - m.width : a.left
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - m.width))

    setStyle((prev) =>
      prev.top === top && prev.left === left && prev.visibility === 'visible'
        ? prev
        : { position: 'fixed', top, left, visibility: 'visible' }
    )
  })

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    const dismiss = (): void => onCloseRef.current()
    // scrolling inside the menu itself must not dismiss it
    const dismissOnScroll = (event: Event): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      onCloseRef.current()
    }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismissOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismissOnScroll, true)
    }
  }, [anchorRef])

  return createPortal(
    <div ref={menuRef} style={style} className={`z-50 ${className}`}>
      {children}
    </div>,
    document.body
  )
}
