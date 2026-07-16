import type { InstalledBuild, RemoteBuild } from '../../../../shared/types'

/** one row of the Installs list — either a catalog build to install (copy === null)
 *  or one specific installed copy (copy !== null). Identical versions installed in
 *  several folders each get their own row. A catalog build that supersedes an
 *  installed copy has no row of its own — it rides on the copy's row as `update`. */
export interface DisplayRow {
  key: string
  version: string
  releaseCycle: string
  branch: string
  commit: string
  remoteBuild: RemoteBuild | null
  update: RemoteBuild | null
  copy: InstalledBuild | null
}
