import type { AddonGroupRow } from '../../../../shared/addon-identity'
import type { AddonInfo, LibraryAddon } from '../../../../shared/types'

// where an available-but-not-installed row can be installed from, for the cell checkboxes
export interface InstallSource {
  kind: 'superhive' | 'library' | 'blender_org' | 'backup'
  /** grouping key: superhive pkgId | library id | blender.org groupId | `<module>@<sourceMinor>` */
  id: string
  minBlender: string | null
  maxBlender: string | null
  isExtension: boolean
  /** 'backup' carry: exact module + the version whose installed copy gets packed on Apply */
  module?: string
  sourceMinor?: string
  /** the carried add-on was dropped by Blender with no replacement — warn before installing */
  unsupported?: boolean
}

// one add-on VERSION for the expanded view — installed and/or stored in the Library. Each becomes
// a sub-row that can install THAT version into any compatible Blender the user picks.
export interface MatrixUnit {
  key: string
  label: string
  version: string | null
  libEntry?: LibraryAddon
  /** every installed cell of this version (any origin) — for the per-version toggles */
  cells: [string, AddonInfo][]
  /** the user/extension subset — the Uninstall targets */
  removable: [string, AddonInfo][]
}

export interface MatrixRow extends AddonGroupRow {
  installVia?: InstallSource
  /** every stored library file for this add-on (several versions possible), newest first */
  libraryFiles?: LibraryAddon[]
}
