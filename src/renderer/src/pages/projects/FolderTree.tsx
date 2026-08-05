import { useTranslation } from '../../lib/i18n'
import { ChevronDownIcon } from './icons'
import type { TreeNode } from './tree'

// Presentational folder tree: names, indents and chevrons only. Clicking a name
// selects the node without unfolding it, clicking the chevron only folds — the two
// are independent. Clicking the selected node again clears the filter.

interface FolderTreeProps {
  nodes: TreeNode[]
  selected: string | null
  expanded: Set<string>
  showCounts: boolean
  showGuides: boolean
  onSelect: (key: string | null) => void
  onToggle: (key: string) => void
  onContextMenu: (node: TreeNode, point: { x: number; y: number }) => void
}

const INDENT = 12
// guides sit just left of the row's own chevron, under each ancestor's chevron
const GUIDE_OFFSET = 15

function TreeRow({
  node,
  selected,
  expanded,
  showCounts,
  showGuides,
  onSelect,
  onToggle,
  onContextMenu
}: { node: TreeNode } & Omit<FolderTreeProps, 'nodes'>) {
  const isSelected = selected === node.key
  const isExpanded = expanded.has(node.key)
  const segments = node.label.split(' / ')
  return (
    <>
      <button
        onClick={() => onSelect(isSelected ? null : node.key)}
        onContextMenu={(event) => {
          event.preventDefault()
          onContextMenu(node, { x: event.clientX, y: event.clientY })
        }}
        title={node.fullPath}
        style={{ paddingLeft: `${8 + node.depth * INDENT}px` }}
        className={`relative flex w-full items-center gap-1 rounded-lg py-1 pr-2 text-left text-sm transition-colors ${
          isSelected ? 'bg-selection text-selection-text' : 'text-zinc-300 hover:bg-white/10'
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
        <span className="min-w-0 flex-1 truncate">
          {segments.map((segment, index) => (
            <span key={index}>
              {index > 0 && <span className={isSelected ? 'text-selection-text/50' : 'text-zinc-600'}> / </span>}
              {segment}
            </span>
          ))}
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
            {node.fileCount}
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
            showGuides={showGuides}
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
  showGuides,
  onSelect,
  onToggle,
  onContextMenu
}: FolderTreeProps) {
  const { t } = useTranslation()
  return (
    <div className="w-56 shrink-0 border-r border-white/10 pr-3">
      <button
        onClick={() => onSelect(null)}
        className={`flex w-full items-center rounded-lg px-2 py-1 text-left text-sm transition-colors ${
          selected === null ? 'bg-selection text-selection-text' : 'text-zinc-300 hover:bg-white/10'
        }`}
      >
        {t('projects.treeAll')}
      </button>
      {nodes.length > 0 && <div className="my-1.5 border-t border-white/5" />}
      {nodes.map((node) => (
        <TreeRow
          key={node.key}
          node={node}
          selected={selected}
          expanded={expanded}
          showCounts={showCounts}
          showGuides={showGuides}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )
}
