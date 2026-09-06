import { invoke, isTauri } from '@tauri-apps/api/core'

export interface DesktopPickedProject {
  file: File
  path: string
  key: string
  projectId: string | null
}

export interface DesktopSaveResult {
  cancelled: boolean
  path: string | null
}

export interface DesktopRecentProject {
  key: string
  title: string
  path: string
  openedAt: number
  projectId: string | null
}

export interface DesktopAutosaveVersion {
  id: string
  kind: 'latest' | 'history'
  savedAt: number
  size: number
}

export interface DesktopAutosaveEntry {
  projectId: string
  title: string
  updatedAt: number
  manualSavedAt: number | null
  dismissedAt: number | null
  needsRecovery: boolean
  versions: DesktopAutosaveVersion[]
}

export interface DesktopProjectRevision {
  sessionId: string
  revision: number
}

const MAX_DESKTOP_FIGGRID_BYTES = 256 * 1024 * 1024

const desktopSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`

const projectRevisions = new Map<
  string,
  { projectRef: object; updatedAt: string; revision: number }
>()

export function desktopProjectRevision(project: { id: string; updatedAt: string }): DesktopProjectRevision {
  const current = projectRevisions.get(project.id)
  if (!current || current.projectRef !== project || current.updatedAt !== project.updatedAt) {
    const revision = (current?.revision ?? 0) + 1
    projectRevisions.set(project.id, {
      projectRef: project,
      updatedAt: project.updatedAt,
      revision,
    })
    return { sessionId: desktopSessionId, revision }
  }
  return { sessionId: desktopSessionId, revision: current.revision }
}

function encodeHeader(value: string) {
  return encodeURIComponent(value)
}

function fileNameFromPath(path: string) {
  const name = path.split(/[\\/]/).pop()
  return name || 'project.figgrid'
}

function asUint8Array(payload: Uint8Array | ArrayBuffer): Uint8Array {
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload)
}

async function rawBytes(bundle: Blob | Uint8Array): Promise<Uint8Array> {
  const byteLength = bundle instanceof Uint8Array ? bundle.byteLength : bundle.size
  if (byteLength > MAX_DESKTOP_FIGGRID_BYTES) {
    throw new Error('工程文件超过 256 MB 安全限制。')
  }
  return bundle instanceof Uint8Array
    ? bundle
    : new Uint8Array(await bundle.arrayBuffer())
}

function decodeProjectEnvelope(payload: Uint8Array): DesktopPickedProject | null {
  if (payload.byteLength < 4) throw new Error('桌面文件数据格式无效。')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const metadataLength = view.getUint32(0, true)
  if (metadataLength === 0) return null
  if (metadataLength > payload.byteLength - 4) throw new Error('桌面文件元数据损坏。')
  const metadataStart = 4
  const fileStart = metadataStart + metadataLength
  const metadata = JSON.parse(
    new TextDecoder().decode(payload.subarray(metadataStart, fileStart)),
  ) as { path?: unknown; key?: unknown; projectId?: unknown }
  if (typeof metadata.path !== 'string' || typeof metadata.key !== 'string') {
    throw new Error('桌面文件元数据无效。')
  }
  if (
    metadata.projectId !== undefined &&
    metadata.projectId !== null &&
    typeof metadata.projectId !== 'string'
  ) {
    throw new Error('桌面工程映射元数据无效。')
  }
  const bytes = payload.subarray(fileStart)
  return {
    path: metadata.path,
    key: metadata.key,
    projectId: typeof metadata.projectId === 'string' ? metadata.projectId : null,
    file: new File([bytes], fileNameFromPath(metadata.path), {
      type: 'application/x-figgrid',
    }),
  }
}

export function isDesktopApp() {
  return isTauri()
}

export async function desktopPickFiggrid(): Promise<DesktopPickedProject | null> {
  const payload = await invoke<Uint8Array | ArrayBuffer>('desktop_pick_figgrid')
  return decodeProjectEnvelope(asUint8Array(payload))
}

export async function desktopOpenRecentFiggrid(
  key: string,
): Promise<DesktopPickedProject> {
  const payload = await invoke<Uint8Array | ArrayBuffer>('desktop_open_recent_figgrid', { key })
  const decoded = decodeProjectEnvelope(asUint8Array(payload))
  if (!decoded) throw new Error('最近工程文件不存在。')
  return decoded
}

export async function desktopSaveFiggrid(options: {
  projectId: string
  title: string
  fileName: string
  projectUpdatedAt: string
  sessionId: string
  revision: number
  bundle: Blob | Uint8Array
}): Promise<DesktopSaveResult> {
  const bytes = await rawBytes(options.bundle)
  return invoke<DesktopSaveResult>('desktop_save_figgrid', bytes, {
    headers: {
      'x-project-id': encodeHeader(options.projectId),
      'x-project-title': encodeHeader(options.title),
      'x-file-name': encodeHeader(options.fileName),
      'x-project-updated-at': encodeHeader(options.projectUpdatedAt),
      'x-session-id': encodeHeader(options.sessionId),
      'x-project-revision': encodeHeader(String(options.revision)),
    },
  })
}

export async function desktopAutosaveFiggrid(options: {
  projectId: string
  title: string
  projectUpdatedAt: string
  sessionId: string
  revision: number
  bundle: Blob | Uint8Array
}): Promise<string> {
  const bytes = await rawBytes(options.bundle)
  return invoke<string>('desktop_autosave_figgrid', bytes, {
    headers: {
      'x-project-id': encodeHeader(options.projectId),
      'x-project-title': encodeHeader(options.title),
      'x-project-updated-at': encodeHeader(options.projectUpdatedAt),
      'x-session-id': encodeHeader(options.sessionId),
      'x-project-revision': encodeHeader(String(options.revision)),
    },
  })
}

/**
 * 取走双击 .figgrid 启动时待打开的文件。
 * 挂载时与窗口获得焦点时各调用一次，即可覆盖"冷启动"与"已运行时再双击"两种情况。
 * 没有待处理文件时返回 null，这是正常启动的常见情况。
 */
export async function desktopTakeLaunchFile(): Promise<DesktopPickedProject | null> {
  const payload = await invoke<Uint8Array | ArrayBuffer>('desktop_take_launch_file')
  return decodeProjectEnvelope(asUint8Array(payload))
}

export async function desktopSaveExport(options: {
  fileName: string
  extension: 'png' | 'svg' | 'tif' | 'pptx'
  blob: Blob | Uint8Array
}): Promise<DesktopSaveResult> {
  const bytes = await rawBytes(options.blob)
  return invoke<DesktopSaveResult>('desktop_save_export', bytes, {
    headers: {
      'x-file-name': encodeHeader(options.fileName),
      'x-file-extension': encodeHeader(options.extension),
    },
  })
}

export async function desktopLinkProject(
  projectId: string,
  key: string,
  title: string,
) {
  await invoke('desktop_link_project', { projectId, key, title })
}

export async function desktopListRecentProjects(): Promise<DesktopRecentProject[]> {
  return invoke<DesktopRecentProject[]>('desktop_list_recent_projects')
}

export async function desktopListAutosaves(): Promise<DesktopAutosaveEntry[]> {
  return invoke<DesktopAutosaveEntry[]>('desktop_list_autosaves')
}

export async function desktopReadAutosaveFiggrid(
  projectId: string,
  version: string,
): Promise<File> {
  const payload = await invoke<Uint8Array | ArrayBuffer>('desktop_read_autosave', {
    projectId,
    version,
  })
  const bytes = asUint8Array(payload)
  return new File([bytes], `recovered-${projectId}.figgrid`, {
    type: 'application/x-figgrid',
  })
}

export async function desktopDismissAutosave(projectId: string, updatedAt: number) {
  await invoke('desktop_dismiss_autosave', { projectId, updatedAt })
}
