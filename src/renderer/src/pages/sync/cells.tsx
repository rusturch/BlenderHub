import { formatBytes } from '../../lib/format'
import { useTranslation } from '../../lib/i18n'
import type { SyncComponentState } from '../../../../shared/types'
import type { CellFace } from './types'
import { FACE_DOT, FACE_TITLE_KEYS } from './constants'

export function SyncCell({
  state,
  isSource,
  stageable,
  face,
  disabled,
  sourceMinor,
  onToggle
}: {
  state: SyncComponentState | undefined
  isSource: boolean
  stageable: boolean
  /** null — not linked */
  face: CellFace | null
  disabled: boolean
  sourceMinor: string | null
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const present = state?.present ?? false
  const info = present
    ? `${formatBytes(state?.bytes ?? 0)}${(state?.fileCount ?? 0) > 1 ? t('sync.cellFilesSuffix', { count: state?.fileCount ?? 0 }) : ''}`
    : t('sync.notPresent')

  if (isSource) {
    return (
      <td className="bg-blender/5 px-3 py-2.5 text-center">
        <span className="inline-flex items-center justify-center p-1" title={present ? t('sync.cellCopiedFromHere', { info }) : info}>
          {present ? (
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-blender" />
          ) : (
            <span className="text-zinc-700">–</span>
          )}
        </span>
      </td>
    )
  }

  if (!stageable) {
    return (
      <td className="px-3 py-2.5 text-center">
        <span className="inline-flex items-center justify-center p-1" title={info}>
          {present ? (
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" />
          ) : (
            <span className="text-zinc-700">–</span>
          )}
        </span>
      </td>
    )
  }

  const title = face
    ? t('sync.cellFaceTitle', { info, title: t(FACE_TITLE_KEYS[face]) })
    : present
      ? t('sync.cellClickToLinkPresent', { info, source: sourceMinor ?? '' })
      : t('sync.cellClickToLinkAbsent', { source: sourceMinor ?? '' })

  return (
    <td className="px-3 py-2.5 text-center">
      <button
        onClick={onToggle}
        disabled={disabled}
        title={title}
        className="rounded p-1 transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {face ? (
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${FACE_DOT[face]}`} />
        ) : present ? (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" />
        ) : (
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-zinc-600" />
        )}
      </button>
    </td>
  )
}
