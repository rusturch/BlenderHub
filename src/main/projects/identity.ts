import { basename } from 'path'
import type { FileIdentity } from '../config'

// Recognising a file that moved on disk outside the launcher. Names prove nothing —
// .blend files are called scene.blend in every second project — so identity comes from
// the filesystem: the file index inside one volume, the size and timestamp across them.

export interface MovedFile {
  from: string
  to: string
}

interface IdentifiedFile {
  path: string
  identity: FileIdentity
}

export function identityOf(fileStat: {
  size: number
  mtimeMs: number
  ino: number
  dev: number
}): FileIdentity {
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    // 0 stands for "the platform did not tell us"; NTFS and ext both do
    ino: Number.isFinite(fileStat.ino) ? fileStat.ino : 0,
    dev: Number.isFinite(fileStat.dev) ? fileStat.dev : 0
  }
}

// the filesystem itself says it is the same file — a move inside one volume keeps both
const SCORE_FILE_ID = 4
// same bytes, same timestamp — what survives a move between volumes (copy + delete)
const SCORE_STAMP = 2
// tie-breaker only, never enough on its own
const SCORE_NAME = 1

function scoreOf(from: IdentifiedFile, to: IdentifiedFile): number {
  const sameFileId =
    from.identity.ino !== 0 &&
    from.identity.ino === to.identity.ino &&
    from.identity.dev === to.identity.dev
  const sameStamp =
    from.identity.size > 0 &&
    from.identity.size === to.identity.size &&
    from.identity.mtimeMs === to.identity.mtimeMs
  if (!sameFileId && !sameStamp) return -1
  const sameName = basename(from.path).toLowerCase() === basename(to.path).toLowerCase()
  return (
    (sameFileId ? SCORE_FILE_ID : 0) +
    (sameStamp ? SCORE_STAMP : 0) +
    (sameName ? SCORE_NAME : 0)
  )
}

/**
 * Pairs files that vanished with files that appeared in the same scan. Each appeared
 * file is claimed once; a tie between two equally good candidates is left unmatched,
 * because guessing wrong would move a project's history onto a stranger.
 */
export function matchMovedFiles(
  vanished: IdentifiedFile[],
  appeared: IdentifiedFile[]
): MovedFile[] {
  if (vanished.length === 0 || appeared.length === 0) return []
  const moves: MovedFile[] = []
  const claimed = new Set<string>()
  for (const from of [...vanished].sort((a, b) => a.path.localeCompare(b.path))) {
    const ranked = appeared
      .filter((to) => !claimed.has(to.path))
      .map((to) => ({ to, score: scoreOf(from, to) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.to.path.localeCompare(b.to.path))
    if (ranked.length === 0) continue
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) continue
    claimed.add(ranked[0].to.path)
    moves.push({ from: from.path, to: ranked[0].to.path })
  }
  return moves
}
