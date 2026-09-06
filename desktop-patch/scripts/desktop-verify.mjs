import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = process.cwd()
const checks = []

function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

function add(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function requireIncludes(relative, needles, name) {
  const source = read(relative)
  const missing = needles.filter((needle) => !source.includes(needle))
  add(name, missing.length === 0, missing.length === 0 ? 'OK' : `缺少：${missing.join(' / ')}`)
}

try {
  const pkg = JSON.parse(read('package.json'))
  add('Tauri scripts', Boolean(pkg.scripts?.['desktop:dev'] && pkg.scripts?.['desktop:build:windows']), 'desktop scripts')
  add('Locked Windows install', String(pkg.scripts?.['desktop:build:windows'] ?? '').includes('npm ci'), pkg.scripts?.['desktop:build:windows'] ?? 'missing')
  add(
    'Pinned Tauri JS dependencies',
    pkg.dependencies?.['@tauri-apps/api'] === '2.11.1' && pkg.devDependencies?.['@tauri-apps/cli'] === '2.11.4',
    `${pkg.dependencies?.['@tauri-apps/api'] ?? 'missing'} / ${pkg.devDependencies?.['@tauri-apps/cli'] ?? 'missing'}`,
  )

  const baselineText = read('UPSTREAM_BASELINE.json')
  const baseline = JSON.parse(baselineText)
  add(
    'Real upstream baseline schema',
    baseline.schema === 3 &&
      baseline.exactFiles?.['package.json'] === '0f491ba06e7efc3498ae15ef1ef7a78219cfbda7f7a4ce0db3a72452545ff590' &&
      baseline.exactFiles?.['vite.config.ts'] === '79c0fc8e715eba7349b7406d2b6d501df161fa4c19dfb9799cf5a247be5f951b' &&
      baseline.exactFiles?.['src/App.tsx'] === '0f66bd665385f9293becae326a79f5aa191bca4cab3031b08650d9755545b42d' &&
      baseline.exactFiles?.['src/components/ProjectsPage.tsx'] === 'b484e80bd75b379f6d93121fd485a5d3febb543528eb7b27a5cef1985387492f' &&
      baseline.exactFiles?.['src/lib/project-file.ts'] === 'f55fe1f0d3bc7cf7349f924afcde8890d8daa6de4bd421cf55dbc7428d6a39b8' &&
      baseline.exactFiles?.['src/styles.css'] === '11574a5b77169f66ca106c45611d41624e0b03b6a2086756166b30a095d5d785' &&
      Object.keys(baseline.exactFiles ?? {}).length === 6 &&
      Object.keys(baseline.guardedFiles ?? {}).length === 0,
    baseline.sourceRef ?? 'missing',
  )
  if (existsSync(join(root, 'desktop-baseline.json'))) {
    const appliedBaseline = JSON.parse(read('desktop-baseline.json'))
    const manifestSha = createHash('sha256').update(Buffer.from(baselineText)).digest('hex')
    add(
      'Applied baseline sealed',
      appliedBaseline.schema === 2 &&
        appliedBaseline.baselineManifestSha256 === manifestSha &&
        appliedBaseline.verifiedWithOverride === false,
      appliedBaseline.gitHeadAtPatchTime ?? 'content baseline (no git HEAD)',
    )
  } else {
    add('Applied baseline sealed', false, '缺少 desktop-baseline.json')
  }

  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  const security = config.app?.security ?? {}
  const productionConnect = String(security.csp?.['connect-src'] ?? '')
  const productionExternalConnect = productionConnect.replace(/http:\/\/ipc\.localhost/g, '')
  const devConnect = String(security.devCsp?.['connect-src'] ?? '')
  add(
    'Production CSP isolation',
    !/localhost|127\.0\.0\.1|ws:|wss:/.test(productionExternalConnect),
    productionConnect || '缺少 connect-src',
  )
  add(
    'Development CSP HMR',
    /localhost:5173/.test(devConnect) && /ws:\/\//.test(devConnect),
    devConnect || '缺少 devCsp connect-src',
  )

  const capability = JSON.parse(read('src-tauri/capabilities/default.json'))
  const permissions = capability.permissions ?? []
  add(
    'Minimal capability',
    permissions.length === 1 && permissions[0] === 'core:default',
    JSON.stringify(permissions),
  )

  requireIncludes(
    'src-tauri/src/lib.rs',
    [
      'Sha256::digest',
      'MAX_AUTOSAVE_TOTAL_BYTES',
      'AUTOSAVE_RETENTION',
      'x-project-revision',
      'x-session-id',
      'prune_autosaves',
      'project_id: item.project_id.clone()',
      'migrate_manual_fingerprint',
      'migrate_dismissed_fingerprint',
      'file_type().map(|kind| kind.is_dir())',
      'recover_atomic_write',
      '.pending.ready',
      '.pending.commit',
      'tauri_plugin_single_instance::init',
      'ensure_disk_not_changed',
      'disk_fingerprint',
      'sync_all()',
      'sync_regular_file',
      '.read(true)',
      '.write(true)',
      'MoveFileExW',
      'MOVEFILE_WRITE_THROUGH',
      '.marker-tmp-',
      'retire_sidecar',
      '.atomic-gc-',
      'write_checked_ready_marker',
      'read_ready_expectation',
      'marker_write_is_atomic_and_leaves_no_temp_file',
      'recovery_preserves_recreated_target_for_first_checked_save',
      'recovery_respects_external_deletion_for_checked_existing_save',
      'recovery_continues_checked_swap_from_verified_backup',
      'read_figgrid_envelope',
      'atomic_write_replaces_existing_file',
      'recovery_commits_fully_flushed_pending_file',
      'recovery_rejects_uncommitted_pending',
      'recovery_rolls_back_swapped_target_without_commit_marker',
      'recovery_keeps_swapped_target_with_commit_marker',
      'disk_fingerprint_detects_external_change',
    ],
    'Rust desktop hardening',
  )
  const rustSource = read('src-tauri/src/lib.rs')
  const singleInstanceAt = rustSource.indexOf('.plugin(tauri_plugin_single_instance::init')
  const dialogPluginAt = rustSource.indexOf('.plugin(tauri_plugin_dialog::init())')
  add(
    'Single-instance registered first',
    singleInstanceAt >= 0 && dialogPluginAt >= 0 && singleInstanceAt < dialogPluginAt,
    `${singleInstanceAt} / ${dialogPluginAt}`,
  )

  requireIncludes(
    'src-tauri/Cargo.toml',
    [
      'tauri = { version = "=2.11.5"',
      'tauri-build = { version = "=2.6.3"',
      'tauri-plugin-dialog = "=2.7.2"',
      'tauri-plugin-single-instance = "=2.4.3"',
      'serde = { version = "=1.0.228"',
      'serde_json = "=1.0.149"',
      'urlencoding = "=2.1.3"',
      'sha2 = "=0.10.9"',
    ],
    'Pinned Rust desktop baseline',
  )
  requireIncludes(
    'src/lib/desktop.ts',
    [
      'desktopProjectRevision',
      "'x-project-revision'",
      "'x-session-id'",
      'projectId: string | null',
      'payload.subarray(fileStart)',
      'asUint8Array(payload)',
      'MAX_DESKTOP_FIGGRID_BYTES = 256 * 1024 * 1024',
    ],
    'Frontend revision and mapping',
  )
  requireIncludes(
    'src/hooks/useDesktopAutosave.ts',
    ['desktopProjectRevision(project)', 'revision: revision.revision'],
    'Autosave monotonic revision',
  )
  requireIncludes(
    'src/components/DesktopRecentProjects.tsx',
    ['picked.projectId ? { ...copied, id: picked.projectId } : copied'],
    'Recent file stable mapping',
  )
  const appSource = read('src/App.tsx')
  add(
    'Editor stable mapping',
    appSource.includes('picked.projectId ? { ...copied, id: picked.projectId } : copied') &&
      (appSource.match(/const openDesktopProjectFile/g) ?? []).length === 1,
    'native editor open mapping',
  )
  const projectsSource = read('src/components/ProjectsPage.tsx')
  add(
    'Projects stable mapping',
    projectsSource.includes('picked.projectId ? { ...copied, id: picked.projectId } : copied') &&
      (projectsSource.match(/const importDesktopProject/g) ?? []).length === 1,
    'native project import mapping',
  )
  requireIncludes(
    'scripts/desktop-lock.mjs',
    ['desktop-lockfiles.sha256.json', "createHash('sha256')", 'cargo', 'generate-lockfile'],
    'Release lockfile sealing',
  )
  requireIncludes(
    'scripts/desktop-lock-check.mjs',
    [
      'desktop-lockfiles.sha256.json',
      'package-lock.json',
      'src-tauri/Cargo.lock',
      '与已封印 SHA-256 不一致',
    ],
    'Release lockfile verification',
  )
  requireIncludes(
    'src/lib/project-file.ts',
    ["mtime: new Date('1980-01-01T00:00:00Z')"],
    'Deterministic figgrid bundle',
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const width = Math.max(...checks.map((item) => item.name.length))
for (const item of checks) {
  console.log(`${item.ok ? 'OK ' : 'ERR'}  ${item.name.padEnd(width)}  ${item.detail}`)
}

const failed = checks.filter((item) => !item.ok)
if (failed.length) {
  console.error(`\n桌面静态验证失败：${failed.map((item) => item.name).join('、')}`)
  process.exit(1)
}
console.log('\n桌面静态验证通过。')
