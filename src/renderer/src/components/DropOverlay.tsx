import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import type { Page } from './Sidebar'
import type { DroppedItem, DroppedItemKind, DropHandleResult, InstallPhase } from '../../../shared/types'

// Window-wide drag-and-drop: dragging files over the launcher shows a full-window
// target, dropping opens a confirmation dialog listing what each item was recognized
// as (project / add-on / Blender build), and confirming processes them one by one.

type ItemStatus = 'pending' | 'busy' | 'ok' | 'skipped' | 'error'

interface PanelItem extends DroppedItem {
  /** stable row identity — a mixed folder yields rows sharing a path with different kinds */
  key: string
  /** row checkbox: only checked rows are processed — the user picks what a folder drop adds */
  selected: boolean
  status: ItemStatus
  /** result detail from main: added name / versions / error text */
  message: string | null
  /** live phase for build archives (builds:install-progress with buildId "drop:<path>") */
  phase: InstallPhase | null
}

const KIND_PAGE: Partial<Record<DroppedItemKind, Page>> = {
  project: 'projects',
  addon: 'addons',
  'addon-url': 'addons',
  'build-archive': 'installs'
}

const KIND_LABEL_KEY: Record<DroppedItemKind, string> = {
  project: 'drop.itemProject',
  addon: 'drop.itemAddon',
  'addon-url': 'drop.itemAddonUrl',
  'build-archive': 'drop.itemBuildArchive',
  folder: 'drop.itemFolder',
  unknown: 'drop.itemUnknown'
}

/** rows that only inform (folders are rejected, unrecognized files) — never processed */
const isActionable = (kind: DroppedItemKind): boolean => kind !== 'unknown' && kind !== 'folder'

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function KindIcon({ kind }: { kind: DroppedItemKind }) {
  const className = 'h-5 w-5 shrink-0'
  switch (kind) {
    case 'project':
      return (
        <svg className={className} {...ICON_PROPS}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      )
    case 'folder':
      return (
        <svg className={className} {...ICON_PROPS}>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
      )
    case 'addon':
    case 'addon-url':
      return (
        <svg className={className} {...ICON_PROPS}>
          <path d="M10 3.5a2 2 0 1 1 4 0V5h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 1 0-4 0V18H6a1 1 0 0 1-1-1v-4H3.5a2 2 0 1 1 0-4H5V6a1 1 0 0 1 1-1h4z" />
        </svg>
      )
    case 'build-archive':
      return (
        <svg className={className} {...ICON_PROPS}>
          <path d="m21 8-9-5-9 5v8l9 5 9-5Z" />
          <path d="m3.3 8.7 8.7 4.8 8.7-4.8" />
          <path d="M12 13.5V21" />
        </svg>
      )
    default:
      return (
        <svg className={className} {...ICON_PROPS}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.7.3-.9.7-.9 1.7" />
          <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
        </svg>
      )
  }
}

function StatusBadge({ status }: { status: ItemStatus }) {
  if (status === 'busy') {
    return <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
  }
  if (status === 'ok' || status === 'skipped') {
    return (
      <svg
        className={`h-4 w-4 shrink-0 ${status === 'ok' ? 'text-emerald-400' : 'text-zinc-500'}`}
        {...ICON_PROPS}
        strokeWidth={2.2}
      >
        <path d="m4.5 12.5 5 5 10-11" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg className="h-4 w-4 shrink-0 text-red-400" {...ICON_PROPS} strokeWidth={2.2}>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    )
  }
  return null
}

function DropRow({ item, onToggle }: { item: PanelItem; onToggle: ((key: string) => void) | null }) {
  const { t } = useTranslation()
  const subline = (() => {
    if (item.status === 'busy') {
      if (item.phase === 'extracting') return t('installs.extracting')
      if (item.phase === 'finalizing') return t('installs.finalizing')
      return t('drop.adding')
    }
    if (item.status === 'ok') return item.message ?? t('common.done')
    if (item.status === 'skipped') return t('drop.alreadyExists')
    if (item.status === 'error') return item.message ?? t('common.error')
    return item.detail ?? t(KIND_LABEL_KEY[item.kind])
  })()
  const selectable = isActionable(item.kind) && onToggle !== null
  return (
    <div
      onClick={selectable ? () => onToggle(item.key) : undefined}
      className={`flex items-center gap-3 rounded-lg bg-surface-inset px-3 py-2 ${
        !isActionable(item.kind) || (!item.selected && item.status === 'pending') ? 'opacity-60' : ''
      } ${selectable ? 'cursor-pointer' : ''}`}
    >
      {isActionable(item.kind) && (
        <input
          type="checkbox"
          checked={item.selected}
          disabled={onToggle === null}
          onChange={() => onToggle?.(item.key)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <div className="text-zinc-400">
        <KindIcon kind={item.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-200" title={item.path}>
          {item.name}
        </div>
        <div className={`truncate text-xs ${item.status === 'error' ? 'text-red-400' : 'text-zinc-500'}`}>
          {subline}
        </div>
      </div>
      <StatusBadge status={item.status} />
    </div>
  )
}

export default function DropOverlay({
  onDone
}: {
  /** addonSearch: the added add-on's display name when exactly one was added — the
   * Add-ons page pre-fills its search with it so the new row is visible at once */
  onDone: (target: Page | null, addonSearch: string | null) => void
}) {
  const { t } = useTranslation()
  const [hovering, setHovering] = useState(false)
  const [items, setItems] = useState<PanelItem[] | null>(null)
  const [desktopOnly, setDesktopOnly] = useState(false)
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  // dragenter/dragleave fire for every child element crossed — only the outermost
  // pair (depth 0↔1) toggles the overlay
  const depthRef = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => {
    busyRef.current = items !== null || desktopOnly
  }, [items, desktopOnly])

  const acceptDrop = useCallback(async (event: DragEvent) => {
    const { api, isDesktop } = getLauncherApi()
    if (!isDesktop) {
      setDesktopOnly(true)
      return
    }
    const strings: string[] = []
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      try {
        const path = api.getPathForFile(file)
        if (path && !strings.includes(path)) strings.push(path)
      } catch {
        // not a filesystem-backed file (e.g. an image dragged out of a web page)
      }
    }
    // repo sites' "Drag and Drop into Blender" buttons carry a plain-text download
    // URL instead of a file — accept those lines too (uri-list # lines are comments)
    const raw = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || ''
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !/^https?:\/\//i.test(trimmed)) continue
      if (!strings.includes(trimmed)) strings.push(trimmed)
      if (strings.length >= 100) break
    }
    if (strings.length === 0) return
    try {
      const classified = await api.drop.classify(strings)
      setRunning(false)
      setFinished(false)
      setItems(
        classified.map((item) => ({
          ...item,
          key: `${item.kind}|${item.path}`,
          selected: isActionable(item.kind),
          status: 'pending' as const,
          message: null,
          phase: null
        }))
      )
    } catch (error) {
      console.error('drop classification failed', error)
    }
  }, [])

  useEffect(() => {
    // a drag started inside this window (text selected in an input being moved) must
    // not light the overlay up — dragstart/dragend only fire for drags born here
    let internalDrag = false
    const onDragStart = (): void => {
      internalDrag = true
    }
    const onDragEnd = (): void => {
      internalDrag = false
    }
    // files from the OS, or a link/text drag from a browser (the repo sites' install
    // buttons put a plain-text URL into the drag — same payload Blender accepts)
    const hasPayload = (event: DragEvent): boolean => {
      if (internalDrag) return false
      const types = Array.from(event.dataTransfer?.types ?? [])
      return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!hasPayload(event)) return
      event.preventDefault()
      depthRef.current += 1
      if (!busyRef.current) setHovering(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasPayload(event)) return
      // without preventDefault the drop never fires and Chromium navigates to the file
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = busyRef.current ? 'none' : 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!hasPayload(event)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setHovering(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasPayload(event)) return
      event.preventDefault()
      depthRef.current = 0
      setHovering(false)
      if (busyRef.current) return
      void acceptDrop(event)
    }
    window.addEventListener('dragstart', onDragStart)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragstart', onDragStart)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [acceptDrop])

  // build archives report their extract/finalize phases while the dialog is open
  useEffect(() => {
    if (items === null) return
    return getLauncherApi().api.builds.onInstallProgress((progress) => {
      if (!progress.buildId.startsWith('drop:')) return
      const path = progress.buildId.slice('drop:'.length)
      setItems((current) =>
        current === null
          ? current
          : current.map((item) =>
              item.kind === 'build-archive' && item.path === path ? { ...item, phase: progress.phase } : item
            )
      )
    })
  }, [items !== null])

  const runAll = useCallback(async () => {
    if (!items) return
    setRunning(true)
    const { api } = getLauncherApi()
    const patch = (key: string, change: Partial<PanelItem>): void =>
      setItems((current) =>
        current === null ? current : current.map((item) => (item.key === key ? { ...item, ...change } : item))
      )
    for (const item of items) {
      if (!isActionable(item.kind) || !item.selected) continue
      patch(item.key, { status: 'busy' })
      let result: DropHandleResult
      try {
        result = await api.drop.handle(item.path, item.kind)
      } catch (error) {
        result = { status: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
      patch(item.key, { status: result.status, message: result.detail })
    }
    setRunning(false)
    setFinished(true)
  }, [items])

  const close = useCallback((): void => {
    if (running) return
    if (finished && items) {
      const landed =
        items.find((item) => item.status === 'ok') ?? items.find((item) => item.status === 'skipped')
      // exactly one add-on made it in (a re-dropped duplicate counts — it exists) —
      // hand its name over so the Add-ons page can show that row right away
      const addons = items.filter(
        (item) =>
          (item.kind === 'addon' || item.kind === 'addon-url') &&
          (item.status === 'ok' || item.status === 'skipped') &&
          item.message
      )
      onDone(landed ? (KIND_PAGE[landed.kind] ?? null) : null, addons.length === 1 ? addons[0].message : null)
    }
    setItems(null)
    setFinished(false)
  }, [running, finished, items, onDone])

  const toggleItem = useCallback((key: string): void => {
    setItems((current) =>
      current === null
        ? current
        : current.map((item) => (item.key === key ? { ...item, selected: !item.selected } : item))
    )
  }, [])

  const selectedCount = items?.filter((item) => isActionable(item.kind) && item.selected).length ?? 0
  const anySupported = items?.some((item) => isActionable(item.kind)) ?? false

  return (
    <>
      {hovering && (
        // starts below the title bar (h-10 in TitleBar.tsx) — the dashed target must
        // not run under the OS window buttons drawn in that strip
        <div className="pointer-events-none fixed inset-x-0 bottom-0 top-10 z-[70] flex bg-black/60 p-6">
          <div className="flex flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-blender/60 bg-blender/5">
            {/* the text sits on its own dialog surface — over the dimmed page it would
                drown in whatever the current theme renders underneath */}
            <div className="rounded-xl border border-white/10 bg-surface-dialog px-8 py-6 text-center shadow-2xl">
              <svg className="mx-auto h-10 w-10 text-blender" {...ICON_PROPS}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="m17 8-5-5-5 5" />
                <path d="M12 3v12" />
              </svg>
              <div className="mt-3 text-lg font-semibold text-zinc-100">{t('drop.overlayTitle')}</div>
              <div className="mt-1 text-sm text-zinc-400">{t('drop.overlayHint')}</div>
            </div>
          </div>
        </div>
      )}
      {desktopOnly && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setDesktopOnly(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">{t('drop.dialogTitle')}</h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">{t('drop.desktopOnly')}</p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setDesktopOnly(false)}
                className="rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover"
              >
                {t('common.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
      {items && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
          <div
            className="w-full max-w-lg rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">{t('drop.dialogTitle')}</h2>
            <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {items.map((item) => (
                <DropRow key={item.key} item={item} onToggle={running || finished ? null : toggleItem} />
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              {finished ? (
                <button
                  onClick={close}
                  className="rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover"
                >
                  {t('common.done')}
                </button>
              ) : (
                <>
                  <button
                    onClick={close}
                    disabled={running}
                    className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
                  >
                    {t('common.cancel')}
                  </button>
                  {anySupported && (
                    <button
                      onClick={() => void runAll()}
                      disabled={running || selectedCount === 0}
                      className="rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:opacity-50"
                    >
                      {running ? t('drop.adding') : t('drop.addCount', { count: selectedCount })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
