import { useEffect, useState } from 'react'
import {
  desktopLinkProject,
  desktopListRecentProjects,
  desktopOpenRecentFiggrid,
  isDesktopApp,
  type DesktopRecentProject,
} from '../lib/desktop'
import { copyProjectAsNew } from '../lib/project'
import { readFiggridBundle } from '../lib/project-file'
import { saveProject, setLastOpenProjectId } from '../lib/storage'

interface DesktopRecentProjectsProps {
  onOpenProject: (projectId: string) => void
}

export function DesktopRecentProjects({ onOpenProject }: DesktopRecentProjectsProps) {
  const [items, setItems] = useState<DesktopRecentProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  useEffect(() => {
    if (!isDesktopApp()) return
    desktopListRecentProjects()
      .then(setItems)
      .catch(() => undefined)
  }, [])

  if (!isDesktopApp() || items.length === 0) return null

  const openRecent = async (item: DesktopRecentProject) => {
    setBusyKey(item.key)
    setError(null)
    let restored: Awaited<ReturnType<typeof readFiggridBundle>> | null = null
    try {
      const picked = await desktopOpenRecentFiggrid(item.key)
      restored = await readFiggridBundle(picked.file)
      const copied = copyProjectAsNew(restored)
      const imported = picked.projectId ? { ...copied, id: picked.projectId } : copied
      await saveProject(imported)
      await desktopLinkProject(imported.id, picked.key, imported.title)
      await setLastOpenProjectId(imported.id)
      onOpenProject(imported.id)
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '最近工程无法打开。')
    } finally {
      restored?.assets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl))
      setBusyKey(null)
    }
  }

  return (
    <section className="desktop-recents" aria-labelledby="desktop-recents-title">
      <div className="desktop-recents-heading">
        <div>
          <span>DESKTOP FILES</span>
          <h2 id="desktop-recents-title">最近磁盘工程</h2>
        </div>
        <small>由桌面版原生打开/保存记录</small>
      </div>
      {error && <div className="dashboard-error" role="alert">{error}</div>}
      <div className="desktop-recents-list">
        {items.slice(0, 6).map((item) => (
          <button
            type="button"
            key={item.key}
            onClick={() => void openRecent(item)}
            disabled={busyKey !== null}
            title={item.path}
          >
            <strong>{item.title}</strong>
            <span>{new Date(item.openedAt).toLocaleString('zh-CN')}</span>
            <small>{item.path}</small>
          </button>
        ))}
      </div>
    </section>
  )
}
