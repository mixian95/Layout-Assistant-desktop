import { useEffect, useRef, useState } from 'react'
import type { FigureProjectV2 } from '../types'
import { createFiggridBundleInWorker } from '../lib/figgrid-worker'
import { desktopAutosaveFiggrid, desktopProjectRevision, isDesktopApp } from '../lib/desktop'

export type DesktopAutosaveStatus =
  | 'unsupported'
  | 'idle'
  | 'scheduled'
  | 'writing'
  | 'saved'
  | 'error'

export function useDesktopAutosave(project: FigureProjectV2, hydrated: boolean) {
  const supported = isDesktopApp()
  const [status, setStatus] = useState<DesktopAutosaveStatus>(
    supported ? 'idle' : 'unsupported',
  )
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    if (!supported || !hydrated) return
    const generation = ++generationRef.current
    const revision = desktopProjectRevision(project)
    setStatus('scheduled')
    const timer = window.setTimeout(() => {
      const snapshot = project
      void (async () => {
        try {
          setStatus('writing')
          const bundle = await createFiggridBundleInWorker(snapshot)
          if (generation !== generationRef.current) return
          await desktopAutosaveFiggrid({
            projectId: snapshot.id,
            title: snapshot.title,
            projectUpdatedAt: snapshot.updatedAt,
            sessionId: revision.sessionId,
            revision: revision.revision,
            bundle,
          })
          if (generation !== generationRef.current) return
          setLastSavedAt(new Date().toISOString())
          setError(null)
          setStatus('saved')
        } catch (saveError) {
          if (generation !== generationRef.current) return
          setError(saveError instanceof Error ? saveError.message : '桌面自动保存失败。')
          setStatus('error')
        }
      })()
    }, 2_000)
    return () => {
      window.clearTimeout(timer)
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [hydrated, project, supported])

  return { supported, status, lastSavedAt, error }
}
