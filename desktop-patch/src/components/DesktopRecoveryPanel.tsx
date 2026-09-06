import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  desktopDismissAutosave,
  desktopListAutosaves,
  desktopReadAutosaveFiggrid,
  isDesktopApp,
  type DesktopAutosaveEntry,
} from '../lib/desktop'
import { copyProjectAsNew } from '../lib/project'
import { readFiggridBundle } from '../lib/project-file'
import { saveProject, setLastOpenProjectId } from '../lib/storage'

interface DesktopRecoveryPanelProps {
  onOpenProject: (projectId: string) => void
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DesktopRecoveryPanel({ onOpenProject }: DesktopRecoveryPanelProps) {
  const [items, setItems] = useState<DesktopAutosaveEntry[]>([])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await desktopListAutosaves()
    setItems(next)
    setSelected((current) => {
      const updated = { ...current }
      next.forEach((item) => {
        if (!updated[item.projectId] || !item.versions.some((version) => version.id === updated[item.projectId])) {
          updated[item.projectId] = item.versions[0]?.id ?? 'latest'
        }
      })
      return updated
    })
  }, [])

  useEffect(() => {
    if (!isDesktopApp()) return
    refresh().catch(() => undefined)
  }, [refresh])

  const pendingCount = useMemo(
    () => items.filter((item) => item.needsRecovery).length,
    [items],
  )

  if (!isDesktopApp() || items.length === 0) return null

  const restore = async (item: DesktopAutosaveEntry) => {
    const version = selected[item.projectId] ?? 'latest'
    setBusyKey(item.projectId)
    setError(null)
    let restored: Awaited<ReturnType<typeof readFiggridBundle>> | null = null
    try {
      const file = await desktopReadAutosaveFiggrid(item.projectId, version)
      restored = await readFiggridBundle(file)
      const imported = {
        ...copyProjectAsNew(restored),
        title: `${restored.title || item.title}（恢复）`,
      }
      await saveProject(imported)
      await setLastOpenProjectId(imported.id)
      await desktopDismissAutosave(item.projectId, item.updatedAt)
      onOpenProject(imported.id)
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '自动保存版本恢复失败。')
    } finally {
      restored?.assets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl))
      setBusyKey(null)
    }
  }

  const dismiss = async (item: DesktopAutosaveEntry) => {
    setBusyKey(item.projectId)
    setError(null)
    try {
      await desktopDismissAutosave(item.projectId, item.updatedAt)
      await refresh()
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : '无法更新恢复状态。')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <section className="desktop-recovery" aria-labelledby="desktop-recovery-title">
      <div className="desktop-recovery-heading">
        <div>
          <span>RECOVERY</span>
          <h2 id="desktop-recovery-title">桌面恢复中心</h2>
        </div>
        <small>
          {pendingCount > 0
            ? `检测到 ${pendingCount} 个未手动保存的版本`
            : '可恢复最近 10 份磁盘自动保存历史'}
        </small>
      </div>

      {pendingCount > 0 && (
        <div className="desktop-recovery-alert" role="status">
          上次编辑后存在尚未手动保存到工程文件的磁盘副本，可恢复后另存为新工程。
        </div>
      )}
      {error && <div className="dashboard-error" role="alert">{error}</div>}

      <div className="desktop-recovery-list">
        {items.map((item) => (
          <article key={item.projectId} className={item.needsRecovery ? 'is-pending' : undefined}>
            <div className="desktop-recovery-item-main">
              <div>
                <strong>{item.title || '未命名 Figure'}</strong>
                <span>{new Date(item.updatedAt).toLocaleString('zh-CN')}</span>
              </div>
              {item.needsRecovery && <b>建议恢复</b>}
            </div>

            <label>
              <span>版本</span>
              <select
                value={selected[item.projectId] ?? item.versions[0]?.id ?? 'latest'}
                onChange={(event) => {
                  setSelected((current) => ({
                    ...current,
                    [item.projectId]: event.target.value,
                  }))
                }}
                disabled={busyKey !== null}
              >
                {item.versions.map((version) => (
                  <option key={`${item.projectId}-${version.id}`} value={version.id}>
                    {version.kind === 'latest' ? '最新自动保存' : '历史快照'} · {' '}
                    {new Date(version.savedAt).toLocaleString('zh-CN')} · {formatBytes(version.size)}
                  </option>
                ))}
              </select>
            </label>

            <div className="desktop-recovery-actions">
              <button
                type="button"
                onClick={() => void restore(item)}
                disabled={busyKey !== null || item.versions.length === 0}
              >
                {busyKey === item.projectId ? '处理中…' : '恢复为新工程'}
              </button>
              {item.needsRecovery && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void dismiss(item)}
                  disabled={busyKey !== null}
                >
                  忽略本次
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
