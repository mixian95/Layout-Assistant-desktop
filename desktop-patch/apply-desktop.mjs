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
  'scripts/desktop-syntax-check.mjs',
  'src/lib/journal-presets.ts',
  'src/lib/raster-format.ts',
  'src/lib/export-formats.ts',
  'src/lib/pptx.ts',
  'src/lib/export-pptx.ts',
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
  "  desktopPickFiggrid,\n  desktopProjectRevision,\n  desktopSaveExport,\n  desktopSaveFiggrid,\n",
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
// 桌面端用系统原生"另存为"替代浏览器下载。
// Tauri WebView 不支持 <a download> + blob:（wry#349），原版在桌面端
// 会静默失败或落进"下载"文件夹，用户完全看不到文件去了哪。
app = replaceOnce(
  app,
  "      downloadBlob(blob, projectFileName(project, 'png'))\n      setNotice({ type: 'success', text: '高清 PNG 已生成。' })\n",
  "      if (isDesktopApp()) {\n        const saved = await desktopSaveExport({\n          fileName: projectFileName(project, 'png'),\n          extension: 'png',\n          blob,\n        })\n        if (saved.cancelled) return\n        setNotice({ type: 'success', text: `高清 PNG 已保存到 ${saved.path}` })\n      } else {\n        downloadBlob(blob, projectFileName(project, 'png'))\n        setNotice({ type: 'success', text: '高清 PNG 已生成。' })\n      }\n",
  'App.tsx native PNG export',
)
app = replaceOnce(
  app,
  "      downloadBlob(\n        await createSvgBlob(project, layout),\n        projectFileName(project, 'svg'),\n      )\n      setNotice({ type: 'success', text: '可编辑 SVG 已生成。' })\n",
  "      const svgBlob = await createSvgBlob(project, layout)\n      if (isDesktopApp()) {\n        const saved = await desktopSaveExport({\n          fileName: projectFileName(project, 'svg'),\n          extension: 'svg',\n          blob: svgBlob,\n        })\n        if (saved.cancelled) return\n        setNotice({ type: 'success', text: `可编辑 SVG 已保存到 ${saved.path}` })\n      } else {\n        downloadBlob(svgBlob, projectFileName(project, 'svg'))\n        setNotice({ type: 'success', text: '可编辑 SVG 已生成。' })\n      }\n",
  'App.tsx native SVG export',
)
// ---- 期刊尺寸预设 / dpi / TIFF 导出 ----

// types.ts：ExportSettings 增加 dpi 与期刊预设。两者都可选，
// 旧的 .figgrid 与 IndexedDB 工程无需迁移即可继续读取。
{
  const typesPath = join(repoDir, 'src', 'types.ts')
  let types = await readFile(typesPath, 'utf8')
  types = replaceOnce(
    types,
    'export interface ExportSettings {\n  width: number\n}\n',
    'export interface ExportSettings {\n  width: number\n  /** 写入 PNG/TIFF 的物理分辨率；缺省视为 300。 */\n  dpi?: number\n  /** 选中的期刊图幅预设 id，仅用于界面回显。 */\n  journalPreset?: string\n}\n',
    'types.ts export settings dpi',
  )
  await writeFile(typesPath, types)
}

// project.ts：新建工程带上默认 dpi
{
  const projectPath = join(repoDir, 'src', 'lib', 'project.ts')
  let source = await readFile(projectPath, 'utf8')
  source = replaceOnce(
    source,
    "    exportSettings: { width: 3000 },\n",
    "    exportSettings: { width: 3000, dpi: 300 },\n",
    'project.ts default dpi',
  )
  await writeFile(projectPath, source)
}

// InspectorPanel：期刊预设 + dpi + TIFF 按钮
{
  const inspectorPath = join(repoDir, 'src', 'components', 'InspectorPanel.tsx')
  let inspector = await readFile(inspectorPath, 'utf8')
  inspector = replaceOnce(
    inspector,
    "import { EXPORT_WIDTH_PRESETS } from '../constants'\n",
    "import { EXPORT_WIDTH_PRESETS } from '../constants'\nimport {\n  DEFAULT_DPI,\n  DPI_PRESETS,\n  JOURNAL_PRESETS,\n  clampDpi,\n  describePhysicalSize,\n  mmToPixels,\n} from '../lib/journal-presets'\n",
    'InspectorPanel journal preset import',
  )
  inspector = replaceOnce(
    inspector,
    "  onExportPng: () => void\n  onExportSvg: () => void\n",
    "  onExportPng: () => void\n  onExportSvg: () => void\n  onExportTiff: () => void\n",
    'InspectorPanel tiff prop type',
  )
  inspector = replaceOnce(
    inspector,
    "  onExportPng,\n  onExportSvg,\n",
    "  onExportPng,\n  onExportSvg,\n  onExportTiff,\n",
    'InspectorPanel tiff prop destructure',
  )
  inspector = replaceOnce(
    inspector,
    '        <div className="preset-row">\n          {EXPORT_WIDTH_PRESETS.map((width) => (\n',
    `        <label className="select-field">
          <span>期刊图幅</span>
          <select
            value={exportSettings.journalPreset ?? ''}
            onChange={(event) => {
              const id = event.target.value
              if (!id) {
                onExportChange({ journalPreset: undefined })
                return
              }
              const preset = JOURNAL_PRESETS.find((item) => item.id === id)
              if (!preset) return
              onExportChange({
                journalPreset: id,
                width: mmToPixels(preset.widthMm, exportSettings.dpi ?? DEFAULT_DPI),
              })
            }}
          >
            <option value="">自定义</option>
            {JOURNAL_PRESETS.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.journal} · {preset.column}（{preset.widthMm} mm）
              </option>
            ))}
          </select>
          <small>数值取自各刊公开指南，投稿前请以目标期刊当期规范为准。</small>
        </label>
        <div className="preset-row">
          {DPI_PRESETS.map((dpi) => (
            <button
              type="button"
              className={(exportSettings.dpi ?? DEFAULT_DPI) === dpi ? 'is-active' : ''}
              onClick={() => {
                const preset = JOURNAL_PRESETS.find(
                  (item) => item.id === exportSettings.journalPreset,
                )
                onExportChange({
                  dpi,
                  ...(preset ? { width: mmToPixels(preset.widthMm, dpi) } : {}),
                })
              }}
              key={\`dpi-\${dpi}\`}
            >
              {dpi} dpi
            </button>
          ))}
        </div>
        <div className="preset-row">
          {EXPORT_WIDTH_PRESETS.map((width) => (
`,
    'InspectorPanel journal + dpi controls',
  )
  inspector = replaceOnce(
    inspector,
    "          <small>500–10000 px</small>\n        </label>\n",
    `          <small>500–10000 px</small>
        </label>
        {canExport ? (
          <p className="export-physical-size">
            {describePhysicalSize(
              exportSettings.width,
              estimatedHeight,
              clampDpi(exportSettings.dpi ?? DEFAULT_DPI),
            )}
          </p>
        ) : null}
`,
    'InspectorPanel physical size readout',
  )
  await writeFile(inspectorPath, inspector)
}
// InspectorPanel：TIFF 按钮
{
  const inspectorPath = join(repoDir, 'src', 'components', 'InspectorPanel.tsx')
  let inspector = await readFile(inspectorPath, 'utf8')
  inspector = replaceOnce(
    inspector,
    "          {busyAction === 'svg' ? '正在生成 SVG…' : '导出可编辑 SVG'}\n        </button>\n      </CollapsibleSection>\n",
    `          {busyAction === 'svg' ? '正在生成 SVG…' : '导出可编辑 SVG'}
        </button>
        <button
          type="button"
          className="secondary-button export-button"
          onClick={onExportTiff}
          disabled={!canExport || busyAction !== null}
        >
          {busyAction === 'tiff' ? '正在生成 TIFF…' : '导出 TIFF（投稿用）'}
        </button>
      </CollapsibleSection>
`,
    'InspectorPanel tiff button',
  )
  await writeFile(inspectorPath, inspector)
}

// App.tsx：PNG 带 dpi、新增 TIFF 导出、把 .figgrid 拖进窗口即可打开
app = replaceOnce(
  app,
  "import { createPngBlob, createSvgBlob, downloadBlob } from './lib/export'\n",
  "import { createPngBlob, createSvgBlob, downloadBlob } from './lib/export'\nimport {\n  createPngBlobWithDpi,\n  createTiffBlob,\n} from './lib/export-formats'\nimport { DEFAULT_DPI, clampDpi } from './lib/journal-presets'\n",
  'App.tsx export-formats import',
)
app = replaceOnce(
  app,
  "      const blob = await createPngBlob(\n        project,\n        layout,\n        project.exportSettings.width,\n      )\n",
  "      const blob = await createPngBlobWithDpi(\n        project,\n        layout,\n        project.exportSettings.width,\n        clampDpi(project.exportSettings.dpi ?? DEFAULT_DPI),\n      )\n",
  'App.tsx png with dpi',
)
// TIFF 导出函数，紧跟在 exportSvg 之后
app = replaceOnce(
  app,
  "  const saveProjectFile = async () => {\n",
  `  const exportTiff = async () => {
    const layout = requireSolved()
    if (!layout) return
    setBusyAction('tiff')
    try {
      await folderBackup.backupNow()
      const blob = await createTiffBlob(
        project,
        layout,
        project.exportSettings.width,
        clampDpi(project.exportSettings.dpi ?? DEFAULT_DPI),
      )
      if (isDesktopApp()) {
        const saved = await desktopSaveExport({
          fileName: projectFileName(project, 'tif'),
          extension: 'tif',
          blob,
        })
        if (saved.cancelled) return
        setNotice({ type: 'success', text: \`TIFF 已保存到 \${saved.path}\` })
      } else {
        downloadBlob(blob, projectFileName(project, 'tif'))
        setNotice({ type: 'success', text: 'TIFF 已生成。' })
      }
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'TIFF 导出失败。',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const saveProjectFile = async () => {
`,
  'App.tsx tiff export function',
)
app = replaceOnce(
  app,
  "          onExportSvg={() => void exportSvg()}\n",
  "          onExportSvg={() => void exportSvg()}\n          onExportTiff={() => void exportTiff()}\n",
  'App.tsx tiff callback wiring',
)
// 双击 .figgrid 打开 + 把 .figgrid 拖到窗口打开
app = replaceOnce(
  app,
  "  desktopSaveExport,\n  desktopSaveFiggrid,\n",
  "  desktopSaveExport,\n  desktopSaveFiggrid,\n  desktopTakeLaunchFile,\n",
  'App.tsx launch file import',
)
app = replaceOnce(
  app,
  "  const saveProjectFile = async () => {\n",
  `  // 打开一个已解析好的 .figgrid：桌面端与浏览器端共用的收口
  // linked 非空表示文件来自磁盘、带稳定 projectId 与 key，必须沿用既有关联逻辑；
  // 否则保存时会弹"另存为"而不是写回原文件，且同一文件重复打开会不断产生重复工程。
  const adoptRestoredProject = useCallback(
    async (
      restored: FigureProjectV2,
      linked?: { projectId: string | null; key: string | null },
    ) => {
      const copied = copyProjectAsNew(restored)
      const imported = linked?.projectId ? { ...copied, id: linked.projectId } : copied
      await saveProject(imported)
      if (linked?.key) {
        await desktopLinkProject(imported.id, linked.key, imported.title)
      }
      await setLastOpenProjectId(imported.id)
      onOpenProject(imported.id)
      setNotice({ type: 'success', text: \`已打开「\${imported.title}」。\` })
    },
    [onOpenProject, setNotice],
  )

  // 双击 .figgrid 或"打开方式"启动：冷启动时取一次，
  // 窗口重新获得焦点时再取一次（覆盖程序已在运行时又双击文件的情况）
  useEffect(() => {
    if (!isDesktopApp()) return
    let cancelled = false
    const drain = async () => {
      let restored: FigureProjectV2 | null = null
      try {
        const picked = await desktopTakeLaunchFile()
        if (cancelled || !picked) return
        restored = await readFiggridBundle(picked.file)
        if (cancelled) return
        await adoptRestoredProject(restored, {
          projectId: picked.projectId,
          key: picked.key,
        })
      } catch (error) {
        if (!cancelled) {
          setNotice({
            type: 'error',
            text: error instanceof Error ? error.message : '打开工程文件失败。',
          })
        }
      } finally {
        // 不释放会让每次打开都泄漏一批 blob URL
        restored?.assets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl))
      }
    }
    void drain()
    window.addEventListener('focus', drain)
    return () => {
      cancelled = true
      window.removeEventListener('focus', drain)
    }
  }, [adoptRestoredProject, setNotice])

  const saveProjectFile = async () => {
`,
  'App.tsx launch file handling',
)
// 拖 .figgrid 到窗口任意位置即可打开
app = replaceOnce(
  app,
  '    <div className="app-shell">\n',
  `    <div
      className="app-shell"
      onDragOver={(event) => {
        if (
          Array.from(event.dataTransfer.items).some(
            (item) => item.kind === 'file',
          )
        ) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        const file = Array.from(event.dataTransfer.files).find((item) =>
          item.name.toLowerCase().endsWith('.figgrid'),
        )
        // 只拦截 .figgrid；图片仍旧交给左侧素材面板自己的 drop 处理
        if (!file) return
        event.preventDefault()
        void (async () => {
          let restored: FigureProjectV2 | null = null
          try {
            await folderBackup.backupNow()
            restored = await readFiggridBundle(file)
            // 拖进来的只是普通文件，没有磁盘关联信息，按新工程导入
            await adoptRestoredProject(restored)
          } catch (error) {
            setNotice({
              type: 'error',
              text: error instanceof Error ? error.message : '打开工程文件失败。',
            })
          } finally {
            restored?.assets.forEach((asset) =>
              URL.revokeObjectURL(asset.previewUrl),
            )
          }
        })()
      }}
    >
`,
  'App.tsx figgrid drop on window',
)
// PPTX 导出：可在 PowerPoint 中继续编辑
{
  const inspectorPath = join(repoDir, 'src', 'components', 'InspectorPanel.tsx')
  let inspector = await readFile(inspectorPath, 'utf8')
  inspector = replaceOnce(
    inspector,
    "  onExportTiff: () => void\n",
    "  onExportTiff: () => void\n  onExportPptx: () => void\n",
    'InspectorPanel pptx prop type',
  )
  inspector = replaceOnce(
    inspector,
    "  onExportTiff,\n",
    "  onExportTiff,\n  onExportPptx,\n",
    'InspectorPanel pptx prop destructure',
  )
  inspector = replaceOnce(
    inspector,
    "          {busyAction === 'tiff' ? '正在生成 TIFF…' : '导出 TIFF（投稿用）'}\n        </button>\n",
    `          {busyAction === 'tiff' ? '正在生成 TIFF…' : '导出 TIFF（投稿用）'}
        </button>
        <button
          type="button"
          className="secondary-button export-button"
          onClick={onExportPptx}
          disabled={!canExport || busyAction !== null}
        >
          {busyAction === 'pptx' ? '正在生成 PPTX…' : '导出 PPTX（可再编辑）'}
        </button>
`,
    'InspectorPanel pptx button',
  )
  await writeFile(inspectorPath, inspector)
}

app = replaceOnce(
  app,
  "import { DEFAULT_DPI, clampDpi } from './lib/journal-presets'\n",
  "import { DEFAULT_DPI, clampDpi } from './lib/journal-presets'\nimport { createPptxBlob } from './lib/export-pptx'\n",
  'App.tsx pptx import',
)
app = replaceOnce(
  app,
  "  const saveProjectFile = async () => {\n",
  `  const exportPptx = async () => {
    const layout = requireSolved()
    if (!layout) return
    setBusyAction('pptx')
    try {
      await folderBackup.backupNow()
      const blob = await createPptxBlob(
        project,
        layout,
        project.exportSettings.width,
        clampDpi(project.exportSettings.dpi ?? DEFAULT_DPI),
      )
      if (isDesktopApp()) {
        const saved = await desktopSaveExport({
          fileName: projectFileName(project, 'pptx'),
          extension: 'pptx',
          blob,
        })
        if (saved.cancelled) return
        setNotice({ type: 'success', text: \`PPTX 已保存到 \${saved.path}\` })
      } else {
        downloadBlob(blob, projectFileName(project, 'pptx'))
        setNotice({ type: 'success', text: 'PPTX 已生成。' })
      }
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'PPTX 导出失败。',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const saveProjectFile = async () => {
`,
  'App.tsx pptx export function',
)
app = replaceOnce(
  app,
  "          onExportTiff={() => void exportTiff()}\n",
  "          onExportTiff={() => void exportTiff()}\n          onExportPptx={() => void exportPptx()}\n",
  'App.tsx pptx callback wiring',
)
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

// 立刻解析一遍生成的源码。模板字符串拼代码时转义写错一层，
// 文件看起来正常但 esbuild 会在构建阶段才报错，白烧一轮 CI。
{
  const { execFileSync } = await import('node:child_process')
  execFileSync(
    process.execPath,
    [join(repoDir, 'scripts', 'desktop-syntax-check.mjs'), repoDir],
    { stdio: 'inherit' },
  )
}

console.log('Desktop phase-7 cumulative patch applied.')
console.log('Next: npm run desktop:lock')
console.log('Install sealed dependencies: npm ci')
console.log('Doctor: npm run desktop:doctor')
console.log('Static verification: npm run desktop:verify')
console.log('Development: npm run desktop:dev')
console.log('Windows installer: npm run desktop:build:windows')
