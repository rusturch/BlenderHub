import { useTranslation } from '../../lib/i18n'
import { setCompactDragImage } from '../../lib/drag-image'
import { ChevronDownIcon, EyeOffIcon } from './icons'
import type { TreeNode } from './tree'

// Presentational folder tree: names, indents and chevrons only. Clicking a name
// selects the node without unfolding it, clicking the chevron only folds — the two
// are independent. Clicking the selected node again clears the filter.

/** dragging a project card or another folder onto a row moves it there */
export interface TreeDnd {
  /** row the pointer is over right now and that would accept the drop */
  overKey: string | null
  canDrop: (node: TreeNode) => boolean
  onDragStart: (node: TreeNode) => void
  onDragEnd: () => void
  onDragOver: (node: TreeNode) => void
  onDragLeave: (node: TreeNode) => void
  onDrop: (node: TreeNode) => void
}

interface FolderTreeProps {
  nodes: TreeNode[]
  selected: string | null
  expanded: Set<string>
  showCounts: boolean
  /** counts and the selection filter both ignore subfolders */
  directOnly: boolean
  showGuides: boolean
  dnd: TreeDnd
  /** shown next to "All projects" while the tree holds folders with no projects */
  onHideEmpty?: () => void
  onSelect: (key: string | null) => void
  onToggle: (key: string) => void
  onContextMenu: (node: TreeNode, point: { x: number; y: number }) => void
}

/** payload of an in-app drag: the dragged folder's or project's absolute path */
export const TREE_DRAG_TYPE = 'application/x-blenderhub-path'

const INDENT = 12
// guides sit just left of the row's own chevron, under each ancestor's chevron
const GUIDE_OFFSET = 15

function TreeRow({
  node,
  selected,
  expanded,
  showCounts,
  directOnly,
  showGuides,
  dnd,
  onSelect,
  onToggle,
  onContextMenu
}: { node: TreeNode } & Omit<FolderTreeProps, 'nodes'>) {
  const isSelected = selected === node.key
  const isExpanded = expanded.has(node.key)
  const isDropTarget = dnd.overKey === node.key
  return (
    <>
      <button
        onClick={() => onSelect(isSelected ? null : node.key)}
        onContextMenu={(event) => {
          event.preventDefault()
          onContextMenu(node, { x: event.clientX, y: event.clientY })
        }}
        draggable
        onDragStart={(event) => {
          // a private type: the OS-file overlay ignores what it cannot read anyway,
          // and it keeps other apps from receiving a half-meaningful payload
          event.dataTransfer.setData(TREE_DRAG_TYPE, node.fullPath)
          event.dataTransfer.effectAllowed = 'move'
          setCompactDragImage(event, 'folder')
          dnd.onDragStart(node)
        }}
        onDragEnd={dnd.onDragEnd}
        onDragOver={(event) => {
          if (!dnd.canDrop(node)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          dnd.onDragOver(node)
        }}
        onDragLeave={() => dnd.onDragLeave(node)}
        onDrop={(event) => {
          if (!dnd.canDrop(node)) return
          event.preventDefault()
          dnd.onDrop(node)
        }}
        title={node.fullPath}
        style={{ paddingLeft: `${8 + node.depth * INDENT}px` }}
        className={`relative flex w-full items-center gap-1 rounded-lg py-1 pr-2 text-left text-sm transition-colors ${
          isDropTarget
            ? 'bg-selection/40 text-selection-text ring-1 ring-inset ring-selection'
            : isSelected
              ? 'bg-selection text-selection-text'
              : 'text-zinc-300 hover:bg-white/10'
        }`}
      >
        {showGuides &&
          Array.from({ length: node.depth }, (_, level) => (
            // absolute, inset-y-0: segments of adjacent rows join into one line
            <span
              key={level}
              aria-hidden="true"
              style={{ left: `${GUIDE_OFFSET + level * INDENT}px` }}
              className="pointer-events-none absolute inset-y-0 border-l border-white/10"
            />
          ))}
        <span
          onClick={(event) => {
            event.stopPropagation()
            if (node.children.length > 0) onToggle(node.key)
          }}
          className={node.children.length === 0 ? 'invisible' : ''}
        >
          <ChevronDownIcon
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${
              isSelected ? 'text-selection-text/70' : 'text-zinc-500'
            } ${isExpanded ? '' : '-rotate-90'}`}
          />
        </span>
        <span className={`min-w-0 flex-1 truncate ${node.fileCount === 0 && !isSelected ? 'text-zinc-500' : ''}`}>
          {node.label}
          {node.suffix && (
            <span className={`ml-1.5 text-[11px] ${isSelected ? 'text-selection-text/60' : 'text-zinc-600'}`}>
              {node.suffix}
            </span>
          )}
        </span>
        {showCounts && (
          <span
            className={`shrink-0 text-[11px] tabular-nums ${
              isSelected ? 'text-selection-text/70' : 'text-zinc-500'
            }`}
          >
            {directOnly ? node.directCount : node.fileCount}
          </span>
        )}
      </button>
      {isExpanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.key}
            node={child}
            selected={selected}
            expanded={expanded}
            showCounts={showCounts}
            directOnly={directOnly}
            showGuides={showGuides}
            dnd={dnd}
            onSelect={onSelect}
            onToggle={onToggle}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  )
}

export default function FolderTree({
  nodes,
  selected,
  expanded,
  showCounts,
  directOnly,
  showGuides,
  dnd,
  onHideEmpty,
  onSelect,
  onToggle,
  onContextMenu
}: FolderTreeProps) {
  const { t } = useTranslation()
  return (
    <div className="w-56 shrink-0 border-r border-white/10 pr-3">
      <div className="flex items-center gap-1">
        <button
          onClick={() => onSelect(null)}
          className={`flex min-w-0 flex-1 items-center rounded-lg px-2 py-1 text-left text-sm transition-colors ${
            selected === null ? 'bg-selection text-selection-text' : 'text-zinc-300 hover:bg-white/10'
          }`}
        >
          {t('projects.treeAll')}
        </button>
        {onHideEmpty && (
          <button
            onClick={onHideEmpty}
            title={t('projects.hideEmptyFolders')}
            className="shrink-0 rounded-lg p-1 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
          >
            <EyeOffIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {nodes.length > 0 && <div className="my-1.5 border-t border-white/5" />}
      {nodes.map((node) => (
        <TreeRow
          key={node.key}
          node={node}
          selected={selected}
          expanded={expanded}
          showCounts={showCounts}
          directOnly={directOnly}
          showGuides={showGuides}
          dnd={dnd}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )
}
