import type { BlendFileInfo, ProjectFolder } from '../../../../shared/types'

// Pure folder-tree construction for the Projects page. Built entirely from the
// already-loaded file list — no filesystem access: a folder exists in the tree
// exactly when at least one live .blend from files[] sits in its subtree.

export interface TreeNode {
  /** stable id: "<root path lower>|<relative dir lower, / separated>" */
  key: string
  /** display name; compressed chains carry several segments joined by " / " */
  label: string
  /** dim disambiguation, set only when two top-level nodes share a name */
  suffix?: string
  /** absolute directory path, for tooltips */
  fullPath: string
  depth: number
  /** live files in this subtree */
  fileCount: number
  children: TreeNode[]
}

export interface ProjectTree {
  nodes: TreeNode[]
  /** file path → key of the node its directory maps to */
  keyOfFile: Map<string, string>
  /** every key present in nodes, for validating a persisted selection */
  nodeKeys: Set<string>
}

const SEP = /[\\/]+/

/** true when fileKey lies in the subtree of nodeKey (key space, segment-safe) */
export function isUnderKey(fileKey: string, nodeKey: string): boolean {
  if (nodeKey.endsWith('|')) return fileKey.startsWith(nodeKey)
  return fileKey === nodeKey || fileKey.startsWith(nodeKey + '/')
}

/** last path segment; a bare drive root ("E:\") keeps the full path as its name */
function dirLabel(path: string): string {
  const segments = path.split(SEP).filter(Boolean)
  return segments.length > 1 ? segments[segments.length - 1] : path
}

/** parent directory for the disambiguation suffix; drive roots have none */
function parentLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index > 0 ? trimmed.slice(0, index) : ''
}

interface DirEntry {
  name: string
  relLower: string
  direct: number
  children: Map<string, DirEntry>
}

function relSegments(filePath: string, rootPath: string): string[] | null {
  if (!filePath.toLowerCase().startsWith(rootPath.toLowerCase())) return null
  const rest = filePath.slice(rootPath.length)
  // segment boundary: the root either ends with a separator or the rest starts with one
  if (rest && !SEP.test(rest[0]) && !SEP.test(rootPath[rootPath.length - 1])) return null
  return rest.split(SEP).filter(Boolean)
}

function buildRootNode(
  rootPath: string,
  rootLabel: string,
  rootFiles: BlendFileInfo[],
  keyOfFile: Map<string, string>,
  nodeKeys: Set<string>
): TreeNode {
  const rootKey = rootPath.toLowerCase() + '|'
  // tooltips join with the root's own separator style, so POSIX paths stay POSIX
  const sep = rootPath.includes('\\') ? '\\' : '/'
  const top: DirEntry = { name: '', relLower: '', direct: 0, children: new Map() }
  for (const file of rootFiles) {
    const segments = relSegments(file.path, rootPath)
    if (!segments || segments.length === 0) {
      // attribution mismatch — keep the file reachable through the root itself
      keyOfFile.set(file.path, rootKey)
      top.direct++
      continue
    }
    const dirs = segments.slice(0, -1)
    let entry = top
    for (const dir of dirs) {
      const lower = dir.toLowerCase()
      let child = entry.children.get(lower)
      if (!child) {
        child = {
          name: dir,
          relLower: entry.relLower ? `${entry.relLower}/${lower}` : lower,
          direct: 0,
          children: new Map()
        }
        entry.children.set(lower, child)
      }
      entry = child
    }
    entry.direct++
    keyOfFile.set(file.path, entry.relLower ? rootKey + entry.relLower : rootKey)
  }

  const toNode = (entry: DirEntry, depth: number, pathSoFar: string): TreeNode => {
    // compress chains of empty single-child folders ("Work / Blender"), VS Code style
    let label = entry.name
    let current = entry
    let fullPath = `${pathSoFar}${sep}${entry.name}`
    while (current.direct === 0 && current.children.size === 1) {
      const only = [...current.children.values()][0]
      label = `${label} / ${only.name}`
      fullPath = `${fullPath}${sep}${only.name}`
      current = only
    }
    const key = rootKey + current.relLower
    nodeKeys.add(key)
    const children = [...current.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => toNode(child, depth + 1, fullPath))
    const fileCount = current.direct + children.reduce((sum, child) => sum + child.fileCount, 0)
    return { key, label, fullPath, depth, fileCount, children }
  }

  nodeKeys.add(rootKey)
  const children = [...top.children.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => toNode(child, 1, rootPath.replace(/[\\/]+$/, '')))
  return {
    key: rootKey,
    label: rootLabel,
    fullPath: rootPath,
    depth: 0,
    fileCount: top.direct + children.reduce((sum, child) => sum + child.fileCount, 0),
    children
  }
}

export function buildProjectTree(files: BlendFileInfo[], folders: ProjectFolder[]): ProjectTree {
  const live = files.filter((file) => !file.missing)
  // group by the source folder the scan attributed each file to: the registered
  // root for folder-scanned files, the parent directory for individually added ones
  const groups = new Map<string, { path: string; files: BlendFileInfo[] }>()
  for (const file of live) {
    const lower = file.folder.toLowerCase()
    let group = groups.get(lower)
    if (!group) {
      group = { path: file.folder, files: [] }
      groups.set(lower, group)
    }
    group.files.push(file)
  }

  const keyOfFile = new Map<string, string>()
  const nodeKeys = new Set<string>()
  const nodes: TreeNode[] = []
  // registered roots first, in registration order (matches Settings and the banners)
  for (const folder of folders) {
    if (folder.missing) continue
    const group = groups.get(folder.path.toLowerCase())
    if (!group) continue
    nodes.push(buildRootNode(group.path, folder.name, group.files, keyOfFile, nodeKeys))
    groups.delete(folder.path.toLowerCase())
  }
  // what remains are parent folders of individually added files — plain leaf
  // folders in the tree, deliberately not expanded up to the drive root
  const extras = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path))
  for (const group of extras) {
    nodes.push(buildRootNode(group.path, dirLabel(group.path), group.files, keyOfFile, nodeKeys))
  }

  // disambiguate top-level nodes that share a name (two "Projects" on different drives)
  const byLabel = new Map<string, TreeNode[]>()
  for (const node of nodes) {
    const lower = node.label.toLowerCase()
    const list = byLabel.get(lower)
    if (list) list.push(node)
    else byLabel.set(lower, [node])
  }
  for (const list of byLabel.values()) {
    if (list.length < 2) continue
    for (const node of list) {
      const parent = parentLabel(node.fullPath)
      if (parent) node.suffix = parent
    }
  }

  return { nodes, keyOfFile, nodeKeys }
}
