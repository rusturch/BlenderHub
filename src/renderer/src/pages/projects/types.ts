export interface ProjectsPageProps {
  versionFilter: string
  onVersionFilterChange: (version: string) => void
  onShowInstalls?: (version: string) => void
}
