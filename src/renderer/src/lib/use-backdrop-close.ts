import { useRef } from 'react'
import type { MouseEvent } from 'react'

/**
 * Backdrop props for a modal: close only on a click that both started and ended on the
 * backdrop itself. A press that begins inside the dialog — selecting text in a field,
 * dragging a slider — sends its click to the common ancestor when the button is released
 * outside, and that must not read as "clicked away".
 */
export function useBackdropClose(onClose: () => void): {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
  onClick: (event: MouseEvent<HTMLDivElement>) => void
} {
  const pressedBackdrop = useRef(false)
  return {
    onMouseDown: (event) => {
      pressedBackdrop.current = event.target === event.currentTarget
    },
    onClick: (event) => {
      const clean = pressedBackdrop.current && event.target === event.currentTarget
      pressedBackdrop.current = false
      if (clean) onClose()
    }
  }
}
