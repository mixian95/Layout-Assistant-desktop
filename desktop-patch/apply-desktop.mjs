import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const patchDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(process.argv[2] ?? process.cwd())

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function backupOnce(path) {
  const backup = `${path}.pre-desktop.bak`
  if (await exists(path) && !(await exists(backup))) {
    await writeFile(backup, await readFile(path))
  }
}

function replaceOnce(source, search, replacement, label) {
  if (source.includes(replacement)) return source
  const index = source.indexOf(search)
  if (index < 0) throw new Error(`Cannot patch ${label}: anchor not found`)
  return source.slice(0, index) + replacement + source.slice(index + search.length)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyUpstreamBaseline() {
  const baselinePath = join(patchDir, 'UPSTREAM_BASELINE.json')
  const baselineBytes = await readFile(baselinePath)
  const baseline = JSON.parse(baselineBytes.toString('utf8'))
  const mismatches = []

  const originalSourcePath = async (relative) => {
    const target = join(repoDir, relative)
    const backup = `${target}.pre-desktop.bak`
    return await exists(backup) ? backup : target
  }

  for (const [relative, expected] of Object.entries(baseline.exactFiles ?? {})) {
    const source = await originalSourcePath(relative)
    if (!(await exists(source))) {
      mismatches.push(`${relative}: missing`)
      continue
    }
    const actual = sha256(await readFile(source))
    if (actual !== expected) mismatches.push(`${relative}: sha256=${actual}`)
  }

  for (const [relative, rule] of Object.entries(baseline.guardedFiles ?? {})) {
    const sourcePath = await originalSourcePath(relative)
    if (!(await exists(sourcePath))) {
      mismatches.push(`${relative}: missing`)
      continue
    }
    const source = await readFile(sourcePath, 'utf8')
    const missingAnchors = (rule.anchors ?? []).filter((anchor) => !source.includes(anchor))
    if (missingAnchors.length) {
      mismatches.push(`${relative}: missing ${missingAnchors.length} guarded anchor(s)`)
    }
  }

  if (mismatches.length && process.env.LAYOUT_ASSISTANT_ALLOW_UNVERIFIED_BASELINE !== '1') {
    throw new Error(
      `Upstream baseline mismatch. Refusing to patch unknown source:\n- ${mismatches.join('\n- ')}\n` +
      'If this is an intentional audited fork, set LAYOUT_ASSISTANT_ALLOW_UNVERIFIED_BASELINE=1.'
    )
  }
  if (mismatches.length) {
    console.warn(`Warning: baseline override enabled for:\n- ${mismatches.join('\n- ')}`)
  } else {
    console.log(`Upstream baseline verified: ${baseline.sourceRef}`)
  }

  let gitHead = null
  let gitDirty = null
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
    gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim())
  } catch {}
  await writeFile(
    join(repoDir, 'desktop-baseline.json'),
    `${JSON.stringify({
      schema: 2,
      baselineManifestSha256: sha256(baselineBytes),
      verifiedWithOverride: mismatches.length > 0,
      gitHeadAtPatchTime: gitHead,
      gitWorkingTreeDirtyAtPatchTime: gitDirty,
      baseline,
    }, null, 2)}\n`,
  )
}

await verifyUpstreamBaseline()

const packagePath = join(repoDir, 'package.json')
if (!(await exists(packagePath))) throw new Error(`package.json not found: ${packagePath}`)

const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
if (pkg.name !== 'layout-assistant') {
  console.warn(`Warning: expected package name layout-assistant, got ${pkg.name}`)
}
await backupOnce(packagePath)
pkg.scripts = {
  ...pkg.scripts,
  tauri: 'tauri',
  'desktop:dev': 'tauri dev',
  'desktop:build': 'tauri build',
  'desktop:doctor': 'node scripts/desktop-doctor.mjs',
  'desktop:verify': 'node scripts/desktop-verify.mjs',
  'desktop:lock': 'node scripts/desktop-lock.mjs',
  'desktop:lock:check': 'node scripts/desktop-lock-check.mjs',
  'desktop:test:rust': 'cargo test --manifest-path src-tauri/Cargo.toml --locked --lib',
  'desktop:build:windows': 'npm run desktop:doctor && npm run desktop:verify && npm run desktop:lock:check && npm ci && npm run desktop:test:rust && tauri build --bundles nsis && node scripts/desktop-verify-build.mjs',
}
pkg.dependencies = {
  ...pkg.dependencies,
  '@tauri-apps/api': '2.11.1',
}
pkg.devDependencies = {
  ...pkg.devDependencies,
  '@tauri-apps/cli': '2.11.4',
}
await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)

const vitePath = join(repoDir, 'vite.config.ts')
await backupOnce(vitePath)
await cp(join(patchDir, 'vite.config.desktop.ts'), vitePath)

const tauriTarget = join(repoDir, 'src-tauri')
await mkdir(tauriTarget, { recursive: true })
await cp(join(patchDir, 'src-tauri'), tauriTarget, { recursive: true, force: true })

for (const relative of [
  'src/lib/desktop.ts',
  'src/hooks/useDesktopAutosave.ts',
  'src/components/DesktopRecentProjects.tsx',
  'src/components/DesktopRecoveryPanel.tsx',
  'scripts/desktop-doctor.mjs',
  'scripts/desktop-verify.mjs',
  'scripts/desktop-verify-build.mjs',
  'scripts/desktop-lock.mjs',
  'scripts/desktop-lock-check.mjs',
  'scripts/desktop-make-icons.mjs',
]) {
  const target = join(repoDir, relative)
  await mkdir(dirname(target), { recursive: true })
  await cp(join(patchDir, relative), target, { force: true })
}
await cp(join(patchDir, 'UPSTREAM_BASELINE.json'), join(repoDir, 'UPSTREAM_BASELINE.json'), { force: true })

const appPath = join(repoDir, 'src/App.tsx')
await backupOnce(appPath)
let app = await readFile(appPath, 'utf8')
app = replaceOnce(
  app,
  "import { useFolderBackup } from './hooks/useFolderBackup'\n",
  "import { useFolderBackup } from './hooks/useFolderBackup'\nimport { useDesktopAutosave } from './hooks/useDesktopAutosave'\n",
  'App.tsx desktop autosave import',
)
if (!app.includes("from './lib/desktop'")) {
  app = replaceOnce(
    app,
    "import { createPngBlob, createSvgBlob, downloadBlob } from './lib/export'\n",
    "import { createPngBlob, createSvgBlob, downloadBlob } from './lib/export'\nimport {\n  desktopLinkProject,\n  desktopPickFiggrid,\n  desktopSaveFiggrid,\n  isDesktopApp,\n} from './lib/desktop'\n",
    'App.tsx desktop helpers import',
  )
}
app = replaceOnce(
  app,
  "  desktopLinkProject,\n",
  "  desktopLinkProject,\n  desktopListAutosaves,\n",
  'App.tsx recovery helpers import',
)
app = replaceOnce(
  app,
  "  desktopPickFiggrid,\n  desktopSaveFiggrid,\n",
  "  desktopPickFiggrid,\n  desktopProjectRevision,\n  desktopSaveFiggrid,\n",
  'App.tsx desktop revision import',
)
if (!app.includes('const desktopAutosave = useDesktopAutosave(project, hydrated)')) {
  const hookAnchor = 'const folderBackup = useFolderBackup(project, hydrated)'
  const hookIndex = app.indexOf(hookAnchor)
  if (hookIndex < 0) throw new Error('Cannot patch App.tsx desktop autosave hook: anchor not found')
  const insertAt = hookIndex + hookAnchor.length
  app = app.slice(0, insertAt) + "\n  const desktopAutosave = useDesktopAutosave(project, hydrated)" + app.slice(insertAt)
}
if (!app.includes('const result = await desktopSaveFiggrid({')) {
  app = replaceOnce(
    app,
    `  const saveProjectFile = async () => {\n    setBusyAction('project')\n    try {\n      await folderBackup.backupNow()\n      const bundle = await createFiggridBundle(project)\n      downloadBlob(bundle, projectFileName(project, 'figgrid'))\n      setNotice({ type: 'success', text: '工程文件已保存。' })\n    } catch (error) {\n      setNotice({\n        type: 'error',\n        text: error instanceof Error ? error.message : '工程文件保存失败。',\n      })\n    } finally {\n      setBusyAction(null)\n    }\n  }\n`,
    `  const saveProjectFile = async () => {\n    setBusyAction('project')\n    try {\n      await folderBackup.backupNow()\n      const bundle = await createFiggridBundle(project)\n      if (isDesktopApp()) {\n        const result = await desktopSaveFiggrid({\n          projectId: project.id,\n          title: project.title,\n          fileName: projectFileName(project, 'figgrid'),\n          bundle,\n        })\n        if (result.cancelled) return\n        setNotice({ type: 'success', text: '工程已保存到磁盘文件。' })\n      } else {\n        downloadBlob(bundle, projectFileName(project, 'figgrid'))\n        setNotice({ type: 'success', text: '工程文件已保存。' })\n      }\n    } catch (error) {\n      setNotice({\n        type: 'error',\n        text: error instanceof Error ? error.message : '工程文件保存失败。',\n      })\n    } finally {\n      setBusyAction(null)\n    }\n  }\n`,
    'App.tsx save project',
  )
}
if (!app.includes('projectUpdatedAt: project.updatedAt')) {
  app = replaceOnce(
    app,
    "          fileName: projectFileName(project, 'figgrid'),\n          bundle,\n",
    "          fileName: projectFileName(project, 'figgrid'),\n          projectUpdatedAt: project.updatedAt,\n          bundle,\n",
    'App.tsx save project revision',
  )
}
// 注意：`try { await folderBackup.backupNow()` 在 App.tsx 里出现 4 次
// （exportPng / exportSvg / saveProjectFile ×2），必须用函数签名把锚点唯一化，
// 否则声明会被插进 exportPng，导致 saveProjectFile 里 TS2304 找不到该变量。
app = replaceOnce(
  app,
  "  const saveProjectFile = async () => {\n    setBusyAction('project')\n    try {\n      await folderBackup.backupNow()\n",
  "  const saveProjectFile = async () => {\n    setBusyAction('project')\n    try {\n      const desktopRevision = isDesktopApp() ? desktopProjectRevision(project) : null\n      await folderBackup.backupNow()\n",
  'App.tsx capture desktop revision before async work',
)
app = replaceOnce(
  app,
  "      if (isDesktopApp()) {\n        const result = await desktopSaveFiggrid({\n",
  "      if (desktopRevision) {\n        const result = await desktopSaveFiggrid({\n",
  'App.tsx desktop revision branch',
)
app = replaceOnce(
  app,
  "          projectUpdatedAt: project.updatedAt,\n          bundle,\n",
  "          projectUpdatedAt: project.updatedAt,\n          sessionId: desktopRevision.sessionId,\n          revision: desktopRevision.revision,\n          bundle,\n",
  'App.tsx desktop revision headers',
)
if (!app.includes('const openDesktopProjectFile = async () => {')) {
  app = replaceOnce(
    app,
    "  const openProjectFile = async (file: File) => {\n",
    `  const openDesktopProjectFile = async () => {\n    setBusyAction('open-project')\n    let restored: FigureProjectV2 | null = null\n    try {\n      await folderBackup.backupNow()\n      const picked = await desktopPickFiggrid()\n      if (!picked) return\n      restored = await readFiggridBundle(picked.file)\n      const copied = copyProjectAsNew(restored)\n      const imported = picked.projectId ? { ...copied, id: picked.projectId } : copied\n      await saveProject(imported)\n      await desktopLinkProject(imported.id, picked.key, imported.title)\n      await setLastOpenProjectId(imported.id)\n      onOpenProject(imported.id)\n    } catch (error) {\n      setNotice({\n        type: 'error',\n        text: error instanceof Error ? error.message : '工程文件无法打开。',\n      })\n    } finally {\n      restored?.assets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl))\n      setBusyAction(null)\n    }\n  }\n\n  const openProjectFile = async (file: File) => {\n`,
    'App.tsx native open function',
  )
}
app = replaceOnce(
  app,
  "      restored = await readFiggridBundle(picked.file)\n      const imported = copyProjectAsNew(restored)\n      await saveProject(imported)\n",
  "      restored = await readFiggridBundle(picked.file)\n      const copied = copyProjectAsNew(restored)\n      const imported = picked.projectId ? { ...copied, id: picked.projectId } : copied\n      await saveProject(imported)\n",
  'App.tsx stable disk project mapping',
)
app = replaceOnce(
  app,
  '          <span className="save-status"><i />{saveStatus}</span>',

  `          <span className="save-status">\n            <i />\n            {desktopAutosave.supported\n              ? desktopAutosave.status === 'writing'\n                ? '正在写入磁盘…'\n                : desktopAutosave.status === 'scheduled'\n                  ? '等待磁盘自动保存'\n                  : desktopAutosave.status === 'error'\n                    ? '磁盘自动保存失败'\n                    : desktopAutosave.status === 'saved'\n                      ? '已自动保存到磁盘'\n                      : saveStatus\n              : saveStatus}\n          </span>`,
  'App.tsx save status',
)
app = replaceOnce(
  app,
  '          <button type="button" onClick={() => projectInputRef.current?.click()}>\n            打开工程\n          </button>',
  `          <button\n            type="button"\n            onClick={() => {\n              if (isDesktopApp()) void openDesktopProjectFile()\n              else projectInputRef.current?.click()\n            }}\n          >\n            打开工程\n          </button>`,
  'App.tsx open project button',
)
if (!app.includes('items.some((item) => item.needsRecovery)')) {
  app = replaceOnce(
    app,
    `  useEffect(() => {\n    const syncPage = () => setRoute(routeFromHash())\n    window.addEventListener('hashchange', syncPage)\n    return () => window.removeEventListener('hashchange', syncPage)\n  }, [])\n\n  useEffect(() => {\n    if (route.page !== 'editor' || route.projectId) return\n`,
    `  useEffect(() => {\n    const syncPage = () => setRoute(routeFromHash())\n    window.addEventListener('hashchange', syncPage)\n    return () => window.removeEventListener('hashchange', syncPage)\n  }, [])\n  useEffect(() => {\n    if (!isDesktopApp() || route.page !== 'landing') return\n    let cancelled = false\n    desktopListAutosaves()\n      .then((items) => {\n        if (!cancelled && items.some((item) => item.needsRecovery)) openProjects()\n      })\n      .catch(() => undefined)\n    return () => {\n      cancelled = true\n    }\n  }, [openProjects, route.page])\n  useEffect(() => {\n    if (route.page !== 'editor' || route.projectId) return\n`,
    'App.tsx startup recovery redirect',
  )
}
await writeFile(appPath, app)

const projectFilePath = join(repoDir, 'src/lib/project-file.ts')
await backupOnce(projectFilePath)
let projectFile = await readFile(projectFilePath, 'utf8')
projectFile = replaceOnce(
  projectFile,
  "  const zipped = zipSync(files, { level: 6 })\n",
  "  const zipped = zipSync(files, {\n    level: 6,\n    // Keep bundles byte-stable so desktop recovery can compare content reliably.\n    mtime: new Date('1980-01-01T00:00:00'),\n  })\n",
  'project-file deterministic zip',
)
await writeFile(projectFilePath, projectFile)

const projectsPath = join(repoDir, 'src/components/ProjectsPage.tsx')
await backupOnce(projectsPath)
let projects = await readFile(projectsPath, 'utf8')
projects = replaceOnce(
  projects,
  "import { useCallback, useEffect, useRef, useState } from 'react'\n",
  "import { useCallback, useEffect, useRef, useState } from 'react'\nimport { DesktopRecentProjects } from './DesktopRecentProjects'\n",
  'ProjectsPage recent component import',
)
projects = replaceOnce(
  projects,
  "import { DesktopRecentProjects } from './DesktopRecentProjects'\n",
  "import { DesktopRecentProjects } from './DesktopRecentProjects'\nimport { DesktopRecoveryPanel } from './DesktopRecoveryPanel'\n",
  'ProjectsPage recovery component import',
)
projects = replaceOnce(
  projects,
  "import { readFiggridBundle } from '../lib/project-file'\n",
  "import { readFiggridBundle } from '../lib/project-file'\nimport { desktopLinkProject, desktopPickFiggrid, isDesktopApp } from '../lib/desktop'\n",
  'ProjectsPage desktop helpers import',
)
if (!projects.includes('const importDesktopProject = async () => {')) {
  projects = replaceOnce(
    projects,
    "  const confirmRename = async (projectId: string) => {\n",
    `  const importDesktopProject = async () => {\n    setBusy('import')\n    setError(null)\n    let restored: Awaited<ReturnType<typeof readFiggridBundle>> | null = null\n    try {\n      const picked = await desktopPickFiggrid()\n      if (!picked) return\n      restored = await readFiggridBundle(picked.file)\n      const copied = copyProjectAsNew(restored)\n      const imported = picked.projectId ? { ...copied, id: picked.projectId } : copied\n      await saveProject(imported)\n      await desktopLinkProject(imported.id, picked.key, imported.title)\n      await openProject(imported.id)\n    } catch (importError) {\n      setError(importError instanceof Error\n        ? importError.message\n        : '工程文件无法导入。')\n    } finally {\n      restored?.assets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl))\n      setBusy(null)\n    }\n  }\n\n  const confirmRename = async (projectId: string) => {\n`,
    'ProjectsPage native import function',
  )
}
projects = replaceOnce(
  projects,
  "      restored = await readFiggridBundle(picked.file)\n      const imported = copyProjectAsNew(restored)\n      await saveProject(imported)\n",
  "      restored = await readFiggridBundle(picked.file)\n      const copied = copyProjectAsNew(restored)\n      const imported = picked.projectId ? { ...copied, id: picked.projectId } : copied\n      await saveProject(imported)\n",
  'ProjectsPage stable disk project mapping',
)
projects = replaceOnce(
  projects,
  '            onClick={() => importInputRef.current?.click()}\n',

  `            onClick={() => {\n              if (isDesktopApp()) void importDesktopProject()\n              else importInputRef.current?.click()\n            }}\n`,
  'ProjectsPage import button',
)
if (!projects.includes('<DesktopRecentProjects onOpenProject={onOpenProject} />')) {
  projects = replaceOnce(
    projects,
    '      {error && <div className="dashboard-error" role="alert">{error}</div>}\n\n      {loading ? (',
    '      {error && <div className="dashboard-error" role="alert">{error}</div>}\n      <DesktopRecentProjects onOpenProject={onOpenProject} />\n\n      {loading ? (',
    'ProjectsPage recent component insertion',
  )
}
if (!projects.includes('<DesktopRecoveryPanel onOpenProject={onOpenProject} />')) {
  projects = replaceOnce(
    projects,
    '      <DesktopRecentProjects onOpenProject={onOpenProject} />\n',
    '      <DesktopRecoveryPanel onOpenProject={onOpenProject} />\n      <DesktopRecentProjects onOpenProject={onOpenProject} />\n',
    'ProjectsPage recovery component insertion',
  )
}
await writeFile(projectsPath, projects)

const stylesPath = join(repoDir, 'src/styles.css')
await backupOnce(stylesPath)
let styles = await readFile(stylesPath, 'utf8')
const desktopStyles = `\n/* Desktop-only recent disk files */\n.desktop-recents {\n  margin: 0 0 24px;\n  padding: 18px;\n  border: 1px solid var(--border, #d9dde3);\n  border-radius: 16px;\n  background: var(--panel, #fff);\n}\n.desktop-recents-heading {\n  display: flex;\n  align-items: end;\n  justify-content: space-between;\n  gap: 16px;\n  margin-bottom: 12px;\n}\n.desktop-recents-heading span { font-size: 11px; letter-spacing: .12em; opacity: .6; }\n.desktop-recents-heading h2 { margin: 3px 0 0; font-size: 18px; }\n.desktop-recents-heading small { opacity: .6; }\n.desktop-recents-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }\n.desktop-recents-list button {\n  min-width: 0;\n  padding: 12px 14px;\n  text-align: left;\n  border: 1px solid var(--border, #d9dde3);\n  border-radius: 12px;\n  background: transparent;\n}\n.desktop-recents-list button strong,\n.desktop-recents-list button span,\n.desktop-recents-list button small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.desktop-recents-list button span { margin-top: 4px; font-size: 12px; opacity: .7; }\n.desktop-recents-list button small { margin-top: 5px; opacity: .55; }\n\n.desktop-recovery {\n  margin: 0 0 24px;\n  padding: 18px;\n  border: 1px solid var(--border, #d9dde3);\n  border-radius: 16px;\n  background: var(--panel, #fff);\n}\n.desktop-recovery-heading {\n  display: flex;\n  align-items: end;\n  justify-content: space-between;\n  gap: 16px;\n  margin-bottom: 12px;\n}\n.desktop-recovery-heading span { font-size: 11px; letter-spacing: .12em; opacity: .6; }\n.desktop-recovery-heading h2 { margin: 3px 0 0; font-size: 18px; }\n.desktop-recovery-heading small { opacity: .65; }\n.desktop-recovery-alert {\n  margin: 0 0 12px;\n  padding: 10px 12px;\n  border: 1px solid var(--border, #d9dde3);\n  border-radius: 10px;\n  font-size: 13px;\n}\n.desktop-recovery-list { display: grid; gap: 10px; }\n.desktop-recovery-list article {\n  padding: 12px 14px;\n  border: 1px solid var(--border, #d9dde3);\n  border-radius: 12px;\n}\n.desktop-recovery-list article.is-pending { border-width: 2px; }\n.desktop-recovery-item-main {\n  display: flex;\n  justify-content: space-between;\n  gap: 12px;\n  margin-bottom: 10px;\n}\n.desktop-recovery-item-main strong,\n.desktop-recovery-item-main span { display: block; }\n.desktop-recovery-item-main span { margin-top: 3px; font-size: 12px; opacity: .65; }\n.desktop-recovery-item-main b { font-size: 12px; white-space: nowrap; }\n.desktop-recovery-list label { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: center; gap: 8px; }\n.desktop-recovery-list label span { font-size: 12px; opacity: .65; }\n.desktop-recovery-list select { min-width: 0; width: 100%; }\n.desktop-recovery-actions { display: flex; gap: 8px; margin-top: 10px; }\n`
if (!styles.includes('/* Desktop-only recent disk files */')) styles += desktopStyles
else if (!styles.includes('.desktop-recovery {')) styles += desktopStyles.slice(desktopStyles.indexOf('\n.desktop-recovery {'))
await writeFile(stylesPath, styles)

// Windows 打包必须有 icons/icon.ico，否则 tauri-build 直接失败。
// 图标全部由代码生成，仓库中不保存任何二进制资源。
{
  const { generateIcons } = await import(
    pathToFileURL(join(repoDir, 'scripts', 'desktop-make-icons.mjs')).href
  )
  const written = generateIcons(join(repoDir, 'src-tauri', 'icons'))
  if (written.length) console.log(`Generated app icons: ${written.join(', ')}`)
}

console.log('Desktop phase-7 cumulative patch applied.')
console.log('Next: npm run desktop:lock')
console.log('Install sealed dependencies: npm ci')
console.log('Doctor: npm run desktop:doctor')
console.log('Static verification: npm run desktop:verify')
console.log('Development: npm run desktop:dev')
console.log('Windows installer: npm run desktop:build:windows')
