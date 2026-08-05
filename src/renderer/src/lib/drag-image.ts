import type { DragEvent } from 'react'

const CUBE =
  '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 12 4 7.5"/><path d="m12 12 8-4.5"/><path d="M12 12v9"/>'
const FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'

let lastGhost: HTMLElement | null = null

/**
 * Replace the browser's default drag image — a full-size snapshot of the dragged card
 * or row — with a small glyph at the cursor, so the drop targets stay visible while
 * dragging. The ghost has to be attached and rendered when setDragImage snapshots it
 * (the snapshot is taken in this same task), and is dropped again right after. Cleanup
 * runs on a timer rather than a frame: a hidden window never paints, and a leftover
 * node would then sit in the DOM until reload.
 */
export function setCompactDragImage(event: DragEvent<HTMLElement>, kind: 'project' | 'folder'): void {
  lastGhost?.remove()
  const ghost = document.createElement('div')
  ghost.style.cssText = [
    'position:absolute',
    'top:-1000px',
    'left:-1000px',
    'width:32px',
    'height:32px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border-radius:8px',
    'border:1px solid rgba(255,255,255,0.12)',
    'background:var(--color-surface-menu)',
    'color:var(--color-icon)',
    'pointer-events:none'
  ].join(';')
  ghost.innerHTML =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    `${kind === 'folder' ? FOLDER : CUBE}</svg>`
  document.body.appendChild(ghost)
  event.dataTransfer.setDragImage(ghost, 16, 16)
  lastGhost = ghost
  setTimeout(() => {
    ghost.remove()
    if (lastGhost === ghost) lastGhost = null
  }, 0)
}
