// 便携网页版专用：把"工程存储"换成纯内存实现。
//
// 为什么需要：Chrome / Edge 禁止用 file:// 直接打开的网页使用浏览器数据库
// （IndexedDB），这是浏览器的安全策略，改不了。所以便携版不保留工程，
// 关闭即清空 —— 这正是"即开即用"的预期行为。
//
// 本文件对外暴露的函数名与签名和 storage.ts 完全一致，构建时通过别名整体
// 替换，因此 App.tsx 等 5 个使用方一行都不用改。

import type {
  BackupPreferences,
  FigureProjectV2,
  ProjectSummary,
} from '../types'

// storage.ts 也导出这个常量，useFolderBackup 会用到，必须一并提供。
export const DEFAULT_BACKUP_PREFERENCES: BackupPreferences = {
  enabled: false,
  rootHandle: null,
  projectFolders: {},
  lastBackupAt: {},
  lastHistoryAt: {},
}

const projects = new Map<string, FigureProjectV2>()
const thumbnails = new Map<string, Blob>()
let lastOpenProjectId: string | null = null
let backupPreferences: BackupPreferences | null = null
let activeProject: FigureProjectV2 | null = null

function summarize(project: FigureProjectV2): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    panelCount: project.panelOrder.length,
    thumbnail: thumbnails.get(project.id) ?? null,
    thumbnailUpdatedAt: thumbnails.has(project.id) ? project.updatedAt : null,
  }
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  return Array.from(projects.values())
    .map(summarize)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadProject(
  projectId: string,
): Promise<FigureProjectV2 | null> {
  return projects.get(projectId) ?? null
}

export async function saveProject(project: FigureProjectV2) {
  projects.set(project.id, project)
}

export async function saveProjectThumbnail(
  projectId: string,
  thumbnail: Blob | null,
) {
  if (thumbnail) thumbnails.set(projectId, thumbnail)
  else thumbnails.delete(projectId)
}

export async function renameProject(projectId: string, title: string) {
  const project = projects.get(projectId)
  if (!project) return
  projects.set(projectId, {
    ...project,
    title,
    updatedAt: new Date().toISOString(),
  })
}

export async function duplicateProject(projectId: string) {
  const project = projects.get(projectId)
  if (!project) return null
  const now = new Date().toISOString()
  const copy: FigureProjectV2 = {
    ...project,
    id: `${projectId}-copy-${projects.size + 1}`,
    title: `${project.title} 副本`,
    createdAt: now,
    updatedAt: now,
  }
  projects.set(copy.id, copy)
  return copy.id
}

export async function deleteProject(projectId: string) {
  projects.delete(projectId)
  thumbnails.delete(projectId)
  if (lastOpenProjectId === projectId) lastOpenProjectId = null
}

export async function setLastOpenProjectId(projectId: string | null) {
  lastOpenProjectId = projectId
}

export async function getLastOpenProjectId(): Promise<string | null> {
  return lastOpenProjectId
}

export async function saveBackupPreferences(preferences: BackupPreferences) {
  backupPreferences = preferences
}

export async function loadBackupPreferences(): Promise<BackupPreferences> {
  return backupPreferences ?? { ...DEFAULT_BACKUP_PREFERENCES }
}

export async function clearBackupPreferences() {
  backupPreferences = null
}

export async function saveActiveProject(project: FigureProjectV2) {
  activeProject = project
}

export async function loadActiveProject() {
  return activeProject
}

export async function clearActiveProject() {
  activeProject = null
}
