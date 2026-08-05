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
  /** normalized folder path → node key; keeps a selection alive across tree modes */
  keyOfPath: Map<string, string>
  /** node key → normalized folder path, the reverse lookup */
  pathOfKey: Map<string, string>
}

function invert(keyOfPath: Map<string, string>): Map<string, string> {
  const reverse = new Map<string, string>()
  for (const [path, key] of keyOfPath) reverse.set(key, path)
  return reverse
}

const SEP = /[\\/]+/

/** comparable form of an absolute folder path (case and trailing separators) */
export function pathKeyOf(path: string): string {
  return (path.replace(/[\\/]+$/, '') || path).toLowerCase()
}

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
  nodeKeys: Set<string>,
  keyOfPath: Map<string, string>,
  compress: boolean
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
    while (compress && current.direct === 0 && current.children.size === 1) {
      const only = [...current.children.values()][0]
      label = `${label} / ${only.name}`
      fullPath = `${fullPath}${sep}${only.name}`
      current = only
    }
    const key = rootKey + current.relLower
    nodeKeys.add(key)
    keyOfPath.set(pathKeyOf(fullPath), key)
    const children = [...current.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => toNode(child, depth + 1, fullPath))
    const fileCount = current.direct + children.reduce((sum, child) => sum + child.fileCount, 0)
    return { key, label, fullPath, depth, fileCount, children }
  }

  nodeKeys.add(rootKey)
  keyOfPath.set(pathKeyOf(rootPath), rootKey)
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

function shiftDepth(node: TreeNode, delta: number): void {
  node.depth += delta
  for (const child of node.children) shiftDepth(child, delta)
}

/**
 * A tracked drive root that holds no .blend of its own is a row you can never act
 * on — it only adds a level between "All projects" and the real folders. Drop it and
 * lift its children up; its key leaves the tree too, so no selection can hide there.
 */
function liftEmptyVolumeRoot(
  root: TreeNode,
  nodeKeys: Set<string>,
  keyOfPath: Map<string, string>
): TreeNode[] {
  const isVolume = pathKeyOf(root.fullPath) === pathKeyOf(anchorOf(root.fullPath))
  const directFiles = root.fileCount - root.children.reduce((sum, child) => sum + child.fileCount, 0)
  if (!isVolume || directFiles > 0 || root.children.length === 0) return [root]
  nodeKeys.delete(root.key)
  keyOfPath.delete(pathKeyOf(root.fullPath))
  for (const child of root.children) shiftDepth(child, -1)
  return root.children
}

/** the volume a path starts from: "E:\", "\\server\share\" or POSIX "/" */
function anchorOf(path: string): string {
  if (/^[\\/]{2}/.test(path)) {
    const segments = path.split(SEP).filter(Boolean)
    return `\\\\${segments.slice(0, 2).join('\\')}\\`
  }
  if (/^[a-z]:/i.test(path)) return `${path.slice(0, 2)}\\`
  return '/'
}

/**
 * fullHierarchy renders the folder chain exactly as it sits on disk, starting from
 * the drive — every level gets its own row. The default anchors the tree at the
 * tracked folders instead and merges empty single-child chains into one row, so a
 * tracked drive root does not open with a ladder of folders that hold nothing.
 */
export function buildProjectTree(
  files: BlendFileInfo[],
  folders: ProjectFolder[],
  fullHierarchy = false
): ProjectTree {
  const live = files.filter((file) => !file.missing)
  // Compact mode groups by the source folder the scan attributed each file to (the
  // registered root, or the parent directory for individually added files). Full
  // mode groups by volume instead, so nested roots merge into the one real disk tree.
  const groups = new Map<string, { path: string; files: BlendFileInfo[] }>()
  for (const file of live) {
    const groupPath = fullHierarchy ? anchorOf(file.path) : file.folder
    const lower = groupPath.toLowerCase()
    let group = groups.get(lower)
    if (!group) {
      group = { path: groupPath, files: [] }
      groups.set(lower, group)
    }
    group.files.push(file)
  }

  const keyOfFile = new Map<string, string>()
  const nodeKeys = new Set<string>()
  const keyOfPath = new Map<string, string>()
  const nodes: TreeNode[] = []
  if (fullHierarchy) {
    for (const group of [...groups.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      nodes.push(
        buildRootNode(group.path, group.path, group.files, keyOfFile, nodeKeys, keyOfPath, false)
      )
    }
    return { nodes, keyOfFile, nodeKeys, keyOfPath, pathOfKey: invert(keyOfPath) }
  }
  // registered roots first, in registration order (matches Settings and the banners)
  for (const folder of folders) {
    if (folder.missing) continue
    const group = groups.get(folder.path.toLowerCase())
    if (!group) continue
    const root = buildRootNode(
      group.path,
      folder.name,
      group.files,
      keyOfFile,
      nodeKeys,
      keyOfPath,
      true
    )
    nodes.push(...liftEmptyVolumeRoot(root, nodeKeys, keyOfPath))
    groups.delete(folder.path.toLowerCase())
  }
  // what remains are parent folders of individually added files — plain leaf
  // folders in the tree, deliberately not expanded up to the drive root
  const extras = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path))
  for (const group of extras) {
    const root = buildRootNode(
      group.path,
      dirLabel(group.path),
      group.files,
      keyOfFile,
      nodeKeys,
      keyOfPath,
      true
    )
    nodes.push(...liftEmptyVolumeRoot(root, nodeKeys, keyOfPath))
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

  return { nodes, keyOfFile, nodeKeys, keyOfPath, pathOfKey: invert(keyOfPath) }
}

/**
 * Rows that should start unfolded: every root, plus chains of folders that hold no
 * files of their own — in full hierarchy those are the path ladders the mode exists
 * to show, and leaving them folded would hide the very thing the user asked for.
 */
export function defaultExpandedKeys(nodes: TreeNode[]): string[] {
  const keys: string[] = []
  for (const root of nodes) {
    let node: TreeNode | undefined = root
    while (node && node.children.length > 0) {
      keys.push(node.key)
      const only: TreeNode | undefined = node.children.length === 1 ? node.children[0] : undefined
      node = only && only.fileCount === node.fileCount ? only : undefined
    }
  }
  return keys
}

/**
 * Re-point a selection at this tree. The key alone is not enough: switching between
 * compact and full hierarchy moves the whole key space (roots become volumes), and
 * compression can absorb a folder into a deeper chain node. The folder path the
 * selection stood on survives both, so it is tried before giving up.
 */
export function resolveSelection(
  tree: ProjectTree,
  key: string | null,
  path: string | null
): string | null {
  if (!key) return null
  if (tree.nodeKeys.has(key)) return key
  if (path) {
    const exact = tree.keyOfPath.get(pathKeyOf(path))
    if (exact) return exact
    // the folder itself is gone from the tree — fall to the nearest node below it
    const prefix = pathKeyOf(path)
    const below = [...tree.keyOfPath.entries()]
      .filter(([nodePath]) => nodePath.startsWith(prefix + '\\') || nodePath.startsWith(prefix + '/'))
      .sort((a, b) => a[0].length - b[0].length)[0]
    if (below) return below[1]
  }
  const heirs = [...tree.nodeKeys].filter((candidate) => isUnderKey(candidate, key))
  return heirs.sort((a, b) => a.length - b.length)[0] ?? null
}
