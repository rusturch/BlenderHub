export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** what the cell shows: linked cells are colored by their sync condition */
export type CellFace = 'push' | 'new' | 'unlink' | 'inSync' | 'sourceChanged' | 'targetChanged' | 'conflict'
