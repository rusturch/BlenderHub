import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import type { Page } from './components/Sidebar'
import TitleBar from './components/TitleBar'
import DropOverlay from './components/DropOverlay'
import { DialogProvider } from './components/Dialog'
import { LanguageProvider } from './lib/i18n'
import { getLauncherApi } from './lib/preview-fallback'
import { uiGet, uiSet } from './lib/ui-store'
import ProjectsPage, { clearProjectsTreeSelection } from './pages/Projects'
import InstallsPage from './pages/Installs'
import AddonsPage from './pages/Addons'
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
  // bumped after a completed drag-and-drop or a notification jump: remounts the page
  // area so the target tab re-reads its data (and picks up a prefilled search) even
  // when the jump lands on the tab already open
  const [dropEpoch, setDropEpoch] = useState(0)
  // the sidebar renders it, the title bar toggles it — so it lives in their parent
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => uiGet('sidebar.collapsed') === '1')

  useEffect(() => {
    uiSet('sidebar.collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  const navigate = (target: Page): void => {
    // plain sidebar navigation clears any prefilled search / settings focus
    if (target === 'installs') setInstallsSearch('')
    if (target === 'addons') setAddonsSearch('')
    setSettingsHighlight(null)
    setPage(target)
  }

  const openSettings = (highlight?: string): void => {
    setSettingsHighlight(highlight ?? null)
    setPage('settings')
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
    setSettingsHighlight(null)
    switch (notification.category) {
      case 'launcher-update':
        openSettings('updates')
        return
      case 'superhive-auth':
        openSettings('superhive')
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
    // the remounted Projects page must not hide the dropped file behind a
    // previously selected tree folder
    if (target === 'projects') clearProjectsTreeSelection()
    setSettingsHighlight(null)
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
          />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              current={page}
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
              {page === 'settings' && <SettingsPage highlight={settingsHighlight ?? undefined} />}
            </main>
          </div>
          <DropOverlay onDone={handleDropComplete} />
        </div>
      </DialogProvider>
    </LanguageProvider>
  )
}
