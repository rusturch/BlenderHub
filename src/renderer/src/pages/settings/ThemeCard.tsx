import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Dropdown from '../../components/Dropdown'
import { useDialog } from '../../components/Dialog'
import { useTranslation } from '../../lib/i18n'
import { cleanErrorMessage } from '../../lib/format'
import { getLauncherApi } from '../../lib/preview-fallback'
import { onUiChanged, uiGet, uiSet } from '../../lib/ui-store'
import {
  applyThemeColors,
  applyThemeSelection,
  BUILTIN_THEMES,
  cssColorToHex,
  DEFAULT_PRESET_ID,
  DEFAULT_THEME_COLORS,
  onThemeSelectionChanged,
  withThemeDefaults
} from '../../lib/theme'
import {
  sanitizeThemeColors,
  THEME_COLOR_KEYS,
  THEME_COLOR_VARS,
  THEME_COLORS_UI_KEY,
  THEME_DIRTY_UI_KEY,
  THEME_NAME_MAX,
  THEME_SELECTED_UI_KEY,
  themeIdFromName
} from '../../../../shared/theme'
import type { ThemeColorKey, ThemeColors } from '../../../../shared/theme'
import { ColorPicker } from './ColorPicker'
import { SectionCard } from './cells'
import {
  ChevronDownIcon,
  ExternalIcon,
  FolderIcon,
  PlusIcon,
  SaveIcon,
  TrashIcon,
  UndoIcon
} from './icons'

// The Blender-style theme editor: pick a preset, tweak colors live, save copies
// as files under data/themes. Built-in presets are read-only — saving one forks
// it into a user theme. Every applied change is flattened into ui-state
// (THEME_COLORS_UI_KEY) so startup and the window chrome follow without
// resolving theme files.

const BUILTIN_PREFIX = 'builtin:'
const USER_PREFIX = 'user:'

interface ThemeOption {
  selectionId: string
  name: string
  builtIn: boolean
  colors: ThemeColors
}

// labels come from settings.themeColor.<key> — every ThemeColorKey has an entry
// in the locale files
// rows render in a two-column grid, so keys are ordered to land in related
// pairs: (background, foreground), (button fill, its hover), …
const COLOR_GROUPS: { id: string; labelKey: string; keys: ThemeColorKey[] }[] = [
  {
    id: 'window',
    labelKey: 'settings.themesGroupWindow',
    keys: ['background', 'foreground', 'overlay', 'shade', 'scroll-shadow', 'scrollbar']
  },
  {
    id: 'accent',
    labelKey: 'settings.themesGroupAccent',
    keys: ['accent', 'on-accent', 'accent-button', 'accent-button-hover']
  },
  {
    id: 'selection',
    labelKey: 'settings.themesGroupSelection',
    keys: ['selection', 'selection-text', 'icon', 'icon-hover', 'icon-selected']
  },
  {
    id: 'cards',
    labelKey: 'settings.themesGroupCards',
    keys: ['card-outline', 'card-hover']
  },
  {
    id: 'surfaces',
    labelKey: 'settings.themesGroupSurfaces',
    keys: [
      'surface-panel',
      'surface-card',
      'surface-menu',
      'surface-dialog',
      'surface-input',
      'surface-hover',
      'surface-drawer',
      'surface-inset'
    ]
  },
  {
    id: 'grays',
    labelKey: 'settings.themesGroupGrays',
    keys: [
      'gray-100',
      'gray-200',
      'gray-300',
      'gray-400',
      'gray-500',
      'gray-600',
      'gray-700',
      'gray-800'
    ]
  },
  {
    id: 'status',
    labelKey: 'settings.themesGroupStatus',
    keys: [
      'danger-300',
      'danger-400',
      'danger-500',
      'warning-300',
      'warning-400',
      'warning-500',
      'success-400',
      'success-500',
      'info-300',
      'info-400',
      'info-500',
      'purple-400',
      'purple-500',
      'violet-500'
    ]
  }
]

const iconButtonClass =
  'rounded-lg border border-white/10 p-1.5 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-icon'

function plainColors(source: ThemeColors): Record<string, string> {
  const record: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    const value = source[key]
    if (value) record[key] = value
  }
  return record
}

/**
 * What a row shows: the theme's own value, the stock one, or — for keys whose
 * default is written in CSS in terms of another token — whatever is actually
 * applied on the document right now.
 */
function rowHex(key: ThemeColorKey, colors: ThemeColors): string {
  const value =
    colors[key] ??
    DEFAULT_THEME_COLORS[key] ??
    getComputedStyle(document.documentElement).getPropertyValue(THEME_COLOR_VARS[key])
  return cssColorToHex(value ?? '') ?? '#000000'
}

/** 3/4/6/8 hex digits, with or without "#" → "#rrggbb" / "#rrggbbaa"; else null */
function parseHexInput(raw: string): string | null {
  const digits = raw.trim().replace(/^#/, '').toLowerCase()
  const long = /^[0-9a-f]{3,4}$/.test(digits)
    ? [...digits].map((digit) => digit + digit).join('')
    : digits
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/.test(long)) return null
  // a fully opaque value stays in the short form the theme files use
  return `#${long.length === 8 && long.endsWith('ff') ? long.slice(0, 6) : long}`
}

/** one editor row: label + typeable hex field + native color swatch */
function ColorRow({
  label,
  hex,
  onChange
}: {
  label: string
  hex: string
  onChange: (hex: string) => void
}) {
  // draft is non-null only while the hex field is being edited — outside of
  // that the field mirrors the live value (including edits from the swatch)
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commit = (): void => {
    if (!cancelled.current && draft !== null) {
      const parsed = parseHexInput(draft)
      if (parsed && parsed !== hex) onChange(parsed)
    }
    cancelled.current = false
    setDraft(null)
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-xs text-zinc-400">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <input
          value={draft ?? hex}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setDraft(hex)
            event.currentTarget.select()
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              cancelled.current = true
              event.currentTarget.blur()
            }
          }}
          maxLength={9}
          spellCheck={false}
          className="w-[5.25rem] rounded border border-white/10 bg-surface-input px-1.5 py-0.5 text-center font-mono text-[10px] text-zinc-300 outline-none focus:border-blender/50"
        />
        <ColorPicker hex={hex} onChange={onChange} />
      </span>
    </div>
  )
}

export function ThemeCard({ standalone = false }: { standalone?: boolean }) {
  const { api, isDesktop } = getLauncherApi()
  const themesApi = api.themes
  const { t } = useTranslation()
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()
  const desktopOnlyTitle = isDesktop ? undefined : t('settings.desktopOnlyHint')

  const [userThemes, setUserThemes] = useState<
    { id: string; name: string; colors: ThemeColors }[]
  >([])
  const [selection, setSelection] = useState(
    () => uiGet(THEME_SELECTED_UI_KEY) ?? `${BUILTIN_PREFIX}${DEFAULT_PRESET_ID}`
  )
  const [dirty, setDirty] = useState(() => uiGet(THEME_DIRTY_UI_KEY) === '1')
  const [colors, setColors] = useState<ThemeColors>(() => {
    const stored = uiGet(THEME_COLORS_UI_KEY)
    if (stored) {
      try {
        return withThemeDefaults(sanitizeThemeColors(JSON.parse(stored)))
      } catch {
        // stale value — fall through to the default look
      }
    }
    return { ...DEFAULT_THEME_COLORS }
  })
  const [menuOpen, setMenuOpen] = useState(false)
  // the floating editor exists to tweak colors — greet it with a group open
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(standalone ? ['window'] : [])
  )
  const [editName, setEditName] = useState('')

  const refreshThemes = useCallback(async () => {
    try {
      const list = await themesApi.list()
      setUserThemes(
        list.map((theme) => ({
          id: theme.id,
          name: theme.name,
          colors: sanitizeThemeColors(theme.colors)
        }))
      )
    } catch {
      // browser preview: user themes are simply unavailable
    }
  }, [themesApi])

  useEffect(() => {
    void refreshThemes()
  }, [refreshThemes])

  const options = useMemo<ThemeOption[]>(
    () => [
      ...BUILTIN_THEMES.map((preset) => ({
        selectionId: `${BUILTIN_PREFIX}${preset.id}`,
        name: preset.name,
        builtIn: true,
        colors: preset.colors
      })),
      ...userThemes.map((theme) => ({
        selectionId: `${USER_PREFIX}${theme.id}`,
        name: theme.name,
        builtIn: false,
        colors: theme.colors
      }))
    ],
    [userThemes]
  )

  const currentOption = options.find((option) => option.selectionId === selection)

  useEffect(() => {
    setEditName(currentOption && !currentOption.builtIn ? currentOption.name : '')
  }, [currentOption])

  // color pickers fire on every drag tick — apply instantly, persist trailing
  const pendingColors = useRef<ThemeColors | null>(null)
  const persistTimer = useRef<number | null>(null)
  const flushColors = useCallback(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    if (pendingColors.current) {
      uiSet(THEME_COLORS_UI_KEY, JSON.stringify(plainColors(pendingColors.current)))
      pendingColors.current = null
    }
  }, [])
  const persistColors = useCallback(
    (next: ThemeColors, immediate: boolean) => {
      pendingColors.current = next
      if (immediate) {
        flushColors()
        return
      }
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(flushColors, 300)
    },
    [flushColors]
  )
  useEffect(() => flushColors, [flushColors])

  // mirror edits arriving from the other window (floating editor <-> Settings);
  // the document-level colors are applied by the theme engine, this syncs the UI
  useEffect(
    () =>
      onUiChanged((key, value) => {
        if (key === THEME_COLORS_UI_KEY) {
          // drop our own pending debounced write — it predates the foreign
          // change and would clobber it when the timer fires
          if (persistTimer.current !== null) {
            window.clearTimeout(persistTimer.current)
            persistTimer.current = null
          }
          pendingColors.current = null
          try {
            setColors(withThemeDefaults(sanitizeThemeColors(JSON.parse(value))))
          } catch {
            // half-written value — skip
          }
        } else if (key === THEME_SELECTED_UI_KEY) {
          setSelection(value)
          void refreshThemes()
        } else if (key === THEME_DIRTY_UI_KEY) {
          setDirty(value === '1')
          // dirty flips on save/reset in the other window — its file changed
          void refreshThemes()
        }
      }),
    [refreshThemes]
  )

  // saves/renames/deletes in the other window: re-list whenever this one comes
  // back into focus, and push out the trailing debounced write when it leaves
  // (window close skips React unmount cleanup — pagehide is the reliable hook)
  useEffect(() => {
    const onFocus = (): void => {
      void refreshThemes()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', flushColors)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', flushColors)
    }
  }, [refreshThemes, flushColors])

  const selectTheme = useCallback(
    (option: ThemeOption) => {
      // drop any pending debounced color write — it predates the switch and
      // would clobber the freshly persisted selection when the timer fires
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current)
        persistTimer.current = null
      }
      pendingColors.current = null
      setSelection(option.selectionId)
      setColors(withThemeDefaults(option.colors))
      setDirty(false)
      setMenuOpen(false)
      applyThemeSelection(option.selectionId, option.colors)
    },
    []
  )

  // theme switched via the title-bar picker (same window — ui-store echoes are
  // filtered, so onUiChanged stays silent): mirror the new selection here
  useEffect(
    () =>
      onThemeSelectionChanged(() => {
        if (persistTimer.current !== null) {
          window.clearTimeout(persistTimer.current)
          persistTimer.current = null
        }
        pendingColors.current = null
        setSelection(uiGet(THEME_SELECTED_UI_KEY) ?? `${BUILTIN_PREFIX}${DEFAULT_PRESET_ID}`)
        setDirty(uiGet(THEME_DIRTY_UI_KEY) === '1')
        const stored = uiGet(THEME_COLORS_UI_KEY)
        if (stored) {
          try {
            setColors(withThemeDefaults(sanitizeThemeColors(JSON.parse(stored))))
          } catch {
            // half-written value — skip
          }
        }
      }),
    []
  )

  const editColor = useCallback(
    (key: ThemeColorKey, value: string) => {
      const next = { ...colors, [key]: value }
      setColors(next)
      setDirty(true)
      applyThemeColors(next)
      uiSet(THEME_DIRTY_UI_KEY, '1')
      persistColors(next, false)
    },
    [colors, persistColors]
  )

  const uniqueThemeId = useCallback((name: string, taken: Set<string>) => {
    const base = themeIdFromName(name).slice(0, 36) || 'theme'
    let id = base
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`
    return id
  }, [])

  const saveAs = useCallback(
    async (name: string) => {
      // dedupe against the folder as it is now, not the possibly stale state —
      // otherwise a quick double-duplicate would overwrite its own first copy
      let taken: Set<string>
      try {
        taken = new Set((await themesApi.list()).map((theme) => theme.id))
      } catch {
        taken = new Set(userThemes.map((theme) => theme.id))
      }
      const id = uniqueThemeId(name, taken)
      try {
        await themesApi.save(id, name, plainColors(colors))
        await refreshThemes()
        setSelection(`${USER_PREFIX}${id}`)
        setDirty(false)
        uiSet(THEME_SELECTED_UI_KEY, `${USER_PREFIX}${id}`)
        uiSet(THEME_DIRTY_UI_KEY, '0')
      } catch (error) {
        void alertDialog(cleanErrorMessage(error))
      }
    },
    [alertDialog, colors, refreshThemes, themesApi, uniqueThemeId, userThemes]
  )

  const duplicateTheme = useCallback(() => {
    const sourceName = currentOption?.name ?? t('settings.themes')
    return saveAs(
      t('settings.themesCopyName', { name: sourceName }).trim().slice(0, THEME_NAME_MAX)
    )
  }, [currentOption, saveAs, t])

  const saveTheme = useCallback(async () => {
    if (!currentOption) return
    // built-in presets are read-only — saving forks the edits into a user theme
    if (currentOption.builtIn) {
      await duplicateTheme()
      return
    }
    // clicking Save blurs the rename input first, racing its own save — take the
    // name from the field so the last write carries both the name and the colors
    const name = editName.trim().slice(0, THEME_NAME_MAX) || currentOption.name
    try {
      await themesApi.save(
        currentOption.selectionId.slice(USER_PREFIX.length),
        name,
        plainColors(colors)
      )
      await refreshThemes()
      setDirty(false)
      uiSet(THEME_DIRTY_UI_KEY, '0')
    } catch (error) {
      void alertDialog(cleanErrorMessage(error))
    }
  }, [alertDialog, colors, currentOption, duplicateTheme, editName, refreshThemes, themesApi])

  const commitRename = useCallback(async () => {
    if (!currentOption || currentOption.builtIn) return
    const name = editName.trim().slice(0, THEME_NAME_MAX)
    if (!name || name === currentOption.name) {
      setEditName(currentOption.name)
      return
    }
    try {
      // rename writes the SAVED colors — unsaved edits keep waiting for Save
      await themesApi.save(
        currentOption.selectionId.slice(USER_PREFIX.length),
        name,
        plainColors(currentOption.colors)
      )
      await refreshThemes()
    } catch (error) {
      void alertDialog(cleanErrorMessage(error))
    }
  }, [alertDialog, currentOption, editName, refreshThemes, themesApi])

  const deleteTheme = useCallback(async () => {
    if (!currentOption || currentOption.builtIn) return
    const confirmed = await confirmDialog({
      title: t('settings.themesDeleteConfirmTitle'),
      message: t('settings.themesDeleteConfirmMessage', { name: currentOption.name }),
      variant: 'danger',
      tone: 'danger',
      confirmLabel: t('settings.themesDelete')
    })
    if (!confirmed) return
    try {
      await themesApi.remove(currentOption.selectionId.slice(USER_PREFIX.length))
      await refreshThemes()
      const fallback = options.find(
        (option) => option.selectionId === `${BUILTIN_PREFIX}${DEFAULT_PRESET_ID}`
      )
      if (fallback) selectTheme(fallback)
    } catch (error) {
      void alertDialog(cleanErrorMessage(error))
    }
  }, [alertDialog, confirmDialog, currentOption, options, refreshThemes, selectTheme, t, themesApi])

  const resetTheme = useCallback(() => {
    if (currentOption) selectTheme(currentOption)
  }, [currentOption, selectTheme])

  const openThemesDir = useCallback(() => {
    void themesApi.openDir().catch(() => {})
  }, [themesApi])

  const openEditorWindow = useCallback(() => {
    void themesApi.openEditorWindow().catch(() => {})
  }, [themesApi])

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const triggerLabel = `${currentOption?.name ?? selection.replace(USER_PREFIX, '')}${dirty ? ' *' : ''}`

  return (
    <SectionCard
      title={t('settings.themes')}
      hint={t('settings.themesHint')}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Dropdown
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            align="right"
            menuClassName="max-h-64 w-56 overflow-auto rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
            trigger={
              <button
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex min-w-[10rem] items-center justify-between gap-2 rounded-lg border border-white/10 bg-surface-input px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
              >
                <span className="truncate">{triggerLabel}</span>
                <ChevronDownIcon className="h-4 w-4 shrink-0 text-zinc-500" />
              </button>
            }
          >
            {options.map((option) => (
              <button
                key={option.selectionId}
                onClick={() => selectTheme(option)}
                className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                  selection === option.selectionId
                    ? 'bg-selection text-selection-text'
                    : 'text-zinc-300 hover:bg-white/10'
                }`}
              >
                <span className="truncate">{option.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
                  {(['background', 'accent'] as const).map((key) => (
                    <span
                      key={key}
                      className="h-3 w-3 rounded-full border border-white/20"
                      style={{
                        backgroundColor: option.colors[key] ?? DEFAULT_THEME_COLORS[key]
                      }}
                    />
                  ))}
                </span>
              </button>
            ))}
          </Dropdown>
          <button
            onClick={() => void duplicateTheme()}
            disabled={!isDesktop}
            title={desktopOnlyTitle ?? t('settings.themesDuplicate')}
            className={iconButtonClass}
          >
            <PlusIcon />
          </button>
          <button
            onClick={() => void saveTheme()}
            disabled={!isDesktop || !dirty || !currentOption}
            title={desktopOnlyTitle ?? t('settings.themesSave')}
            className={iconButtonClass}
          >
            <SaveIcon />
          </button>
          <button
            onClick={resetTheme}
            disabled={!dirty || !currentOption}
            title={t('settings.themesReset')}
            className={iconButtonClass}
          >
            <UndoIcon />
          </button>
          <button
            onClick={() => void deleteTheme()}
            disabled={!isDesktop || !currentOption || currentOption.builtIn}
            title={desktopOnlyTitle ?? t('settings.themesDelete')}
            className={iconButtonClass}
          >
            <TrashIcon />
          </button>
          <button
            onClick={openThemesDir}
            disabled={!isDesktop}
            title={desktopOnlyTitle ?? t('settings.themesOpenFolder')}
            className={iconButtonClass}
          >
            <FolderIcon />
          </button>
          {!standalone && (
            <button
              onClick={openEditorWindow}
              disabled={!isDesktop}
              title={desktopOnlyTitle ?? t('settings.themesOpenWindow')}
              className={iconButtonClass}
            >
              <ExternalIcon />
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-1.5">
        {currentOption && !currentOption.builtIn && (
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-zinc-500">{t('settings.themesName')}</span>
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              maxLength={THEME_NAME_MAX}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className="w-56 rounded-lg border border-white/10 bg-surface-input px-3 py-1 text-xs text-zinc-200 outline-none focus:border-blender/60"
            />
          </div>
        )}
        {COLOR_GROUPS.map((group) => {
          const open = openGroups.has(group.id)
          return (
            <div key={group.id} className="rounded-lg border border-white/5">
              <button
                onClick={() => toggleGroup(group.id)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10"
              >
                <ChevronDownIcon
                  className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${
                    open ? '' : '-rotate-90'
                  }`}
                />
                {t(group.labelKey)}
              </button>
              {open && (
                <div className="grid grid-cols-1 gap-x-8 gap-y-1 px-3 pb-3 pt-1 sm:grid-cols-2">
                  {group.keys.map((key) => (
                    <ColorRow
                      key={key}
                      label={t(`settings.themeColor.${key}`)}
                      hex={rowHex(key, colors)}
                      onChange={(value) => editColor(key, value)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}
