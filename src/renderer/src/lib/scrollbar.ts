const HIDE_DELAY_MS = 900
// wider than the rendered 10px thumb so the hot zone is a little forgiving
const SCROLLBAR_HOT_ZONE_PX = 16
const hideTimers = new WeakMap<Element, number>()

function reveal(element: Element): void {
  element.classList.add('scrollbar-active')
  const previous = hideTimers.get(element)
  if (previous !== undefined) window.clearTimeout(previous)
  hideTimers.set(
    element,
    window.setTimeout(() => element.classList.remove('scrollbar-active'), HIDE_DELAY_MS)
  )
}

// the browser reserves the scrollbar's own strip of space from an overflow-y
// element's box — nothing else renders there, so a hovered element IS the
// scrollbar owner exactly when the cursor sits in that reserved right-edge strip
function isOverOwnScrollbarGutter(el: Element, clientX: number): boolean {
  if (el.scrollHeight <= el.clientHeight) return false
  const overflowY = getComputedStyle(el).overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false
  const rect = el.getBoundingClientRect()
  return clientX >= rect.right - SCROLLBAR_HOT_ZONE_PX && clientX <= rect.right
}

// Marks whichever element is being scrolled, or whose vertical scrollbar strip is
// under the cursor, with .scrollbar-active so the CSS in main.css can reveal its
// thumb; the mark is dropped (with a smooth fade) shortly after both stop. Capture
// phase is required for scroll — those events do not bubble.
export function initAutoHideScrollbars(): void {
  document.addEventListener(
    'scroll',
    (event) => {
      const raw = event.target
      reveal(raw instanceof Element ? raw : document.documentElement)
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'mousemove',
    (event) => {
      // hovering an element's own scrollbar gutter reports that element as the
      // target (child content never renders under the reserved scrollbar strip)
      const target = event.target
      if (target instanceof Element && isOverOwnScrollbarGutter(target, event.clientX)) {
        reveal(target)
      }
    },
    { passive: true }
  )
}
