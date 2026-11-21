import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import type { Page } from './components/Sidebar'
import TitleBar from './components/TitleBar'
import DropOverlay from './components/DropOverlay'
import { DialogProvider } from './components/Dialog'
import { LanguageProvider } from './lib/i18n'
import { getLauncherApi } from './lib/preview-fallback'
import { uiGet, uiSet } from './lib/ui-store'
import ProjectsPage, { clearProjectsFilters } from './pages/Projects'
import InstallsPage, { clearInstallsSearch } from './pages/Installs'
import AddonsPage, { clearAddonsSearch } from './pages/Addons'
import SyncPage from './pages/Sync'
import ActivityPage from './pages/Activity'
import SettingsPage from './pages/Settings'
import type { HubNotification } from '../../shared/types'

export default function App() {
  const [page, setPage] = useState<Page>('projects')
  const [projectsVersion, setProjectsVersion] = useState<string>('all')
  const [installsSearch, setInstallsSearch] = useState<string>('')
  const [addonsSearch, setAddonsSearch] = useState<string>('')
  const [settingsHighlight, setSettingsHighlight] = useState<string | null>(null)
  // settings are a window over the current page rather than a page of their own; the
  // epoch remounts it on every open, so a deep link always lands on its own section
  // even when the window is already showing another one
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsEpoch, setSettingsEpoch] = useState(0)
  // bumped after a completed drag-and-drop or a notification jump: remounts the page
  // area so the target tab re-reads its data (and picks up a prefilled search) even
  // when the jump lands on the tab already open
  const [dropEpoch, setDropEpoch] = useState(0)
  // the sidebar renders it, the title bar toggles it — so it lives in their parent
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => uiGet('sidebar.collapsed') === '1')

  useEffect(() => {
    uiSet('sidebar.collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  const openSettings = (highlight?: string): void => {
    setSettingsHighlight(highlight ?? null)
    setSettingsEpoch((epoch) => epoch + 1)
    setSettingsOpen(true)
  }

  const navigate = (target: Page): void => {
    if (target === 'settings') {
      openSettings()
      return
    }
    // plain sidebar navigation clears any prefilled search / settings focus
    if (target === 'installs') setInstallsSearch('')
    if (target === 'addons') setAddonsSearch('')
    setSettingsHighlight(null)
    setSettingsOpen(false)
    setPage(target)
  }

  const showProjectsForVersion = (version: string): void => {
    setProjectsVersion(version)
    setPage('projects')
  }

  const showInstallsForVersion = (version: string): void => {
    setInstallsSearch(version)
    setPage('installs')
  }

  // the tray's page shortcuts land here regardless of which page is currently open
  useEffect(() => getLauncherApi().api.tray.onNavigate(navigate), [])

  // the bell's entries jump to the page that can act on them, carrying a search
  // where one helps pin the exact row
  const handleNotificationClick = (notification: HubNotification): void => {
    // a jump to a page must not leave the settings window covering it; the settings
    // cases below reopen it
    setSettingsHighlight(null)
    setSettingsOpen(false)
    switch (notification.category) {
      case 'launcher-update':
        openSettings('updates')
        return
      case 'superhive-auth':
        openSettings('superhive')
        return
      case 'cloud-sync':
        openSettings('cloud-sync')
        return
      case 'sync-changes':
        setPage('sync')
        return
      case 'addon-update':
        setAddonsSearch(notification.payload.name)
        setDropEpoch((epoch) => epoch + 1)
        setPage('addons')
        return
      case 'blender-update':
        setInstallsSearch(notification.payload.targetVersion)
        setDropEpoch((epoch) => epoch + 1)
        setPage('installs')
        return
      case 'operation':
        setInstallsSearch(notification.payload.version)
        setDropEpoch((epoch) => epoch + 1)
        setPage('installs')
        return
    }
  }

  const handleDropComplete = (target: Page | null, addonSearch: string | null): void => {
    if (!target) return
    // not navigate(): it would wipe the add-on search being handed over
    setAddonsSearch(target === 'addons' && addonSearch ? addonSearch : '')
    if (target === 'installs') setInstallsSearch('')
    // whatever was dropped has to be visible on arrival, so the target page starts
    // without the filters its last visit left behind — a handed-over search still wins
    if (target === 'projects') clearProjectsFilters()
    if (target === 'installs') clearInstallsSearch()
    if (target === 'addons') clearAddonsSearch()
    setSettingsHighlight(null)
    setSettingsOpen(false)
    setDropEpoch((epoch) => epoch + 1)
    setPage(target)
  }

  return (
    <LanguageProvider>
      <DialogProvider>
        {/* panel-colored shell: the only place it shows through is the rounded corner
            where the content area is cut away from it */}
        <div className="flex h-full flex-col bg-surface-panel">
          <TitleBar
            onNotificationClick={handleNotificationClick}
            onOpenNotificationSettings={() => openSettings('notifications')}
            onOpenThemeSettings={() => openSettings('theme')}
            onOpenCloudSettings={() => openSettings('cloud-sync')}
          />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              current={settingsOpen ? 'settings' : page}
              onNavigate={navigate}
              onUpdateClick={() => openSettings('updates')}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
            />
            {/* both hairlines live here, on the content's own edges: one element, one
                border colour, so the horizontal and vertical separators cannot drift
                apart — and they follow the rounded corner. The alpha is higher than a
                plain divider because it composites over the dark content background
                rather than the lighter panel it used to sit on. */}
            <main
              className="min-w-0 flex-1 rounded-tl-xl border-l border-t border-white/10 bg-background"
              key={dropEpoch}
            >
              {page === 'projects' && (
                <ProjectsPage
                  versionFilter={projectsVersion}
                  onVersionFilterChange={setProjectsVersion}
                  onShowInstalls={showInstallsForVersion}
                />
              )}
              {page === 'installs' && (
                <InstallsPage onShowProjects={showProjectsForVersion} initialSearch={installsSearch} />
              )}
              {page === 'addons' && <AddonsPage onOpenSettings={openSettings} initialSearch={addonsSearch} />}
              {page === 'sync' && <SyncPage onShowInstalls={showInstallsForVersion} />}
              {page === 'activity' && <ActivityPage />}
            </main>
          </div>
          {settingsOpen && (
            <SettingsPage
              key={settingsEpoch}
              highlight={settingsHighlight ?? undefined}
              onClose={() => setSettingsOpen(false)}
            />
          )}
          <DropOverlay onDone={handleDropComplete} />
        </div>
      </DialogProvider>
    </LanguageProvider>
  )
}
