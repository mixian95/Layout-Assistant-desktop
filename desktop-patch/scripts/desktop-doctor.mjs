import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const checks = []

function run(command, args = []) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }
}

function add(name, ok, detail, required = true) {
  checks.push({ name, ok, detail, required })
}

const nodeMajor = Number(process.versions.node.split('.')[0])
add('Node.js', nodeMajor >= 20, `${process.version}${nodeMajor >= 20 ? '' : '；建议 Node.js 20+'}`)

const npmVersion = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'])
add('npm', Boolean(npmVersion), npmVersion ?? '未找到 npm')

const rustc = run('rustc', ['--version'])
add('Rust', Boolean(rustc), rustc ?? '未找到 rustc；请先安装 rustup')

const cargo = run('cargo', ['--version'])
add('Cargo', Boolean(cargo), cargo ?? '未找到 cargo；通常随 rustup 安装')

if (cargo) {
  const metadata = run('cargo', [
    'metadata',
    '--no-deps',
    '--format-version', '1',
    '--manifest-path', 'src-tauri/Cargo.toml',
  ])
  add('Cargo manifest', Boolean(metadata), metadata ? 'src-tauri/Cargo.toml 可解析' : 'Cargo manifest 无法解析')
}

const host = run('rustc', ['-vV'])?.match(/^host:\s*(.+)$/m)?.[1] ?? null
if (process.platform === 'win32') {
  add(
    'Rust MSVC toolchain',
    Boolean(host?.endsWith('-pc-windows-msvc')),
    host ?? '无法读取 Rust host；建议运行 rustup default stable-msvc',
  )

  const installedTargets = run('rustup', ['target', 'list', '--installed'])
  add(
    'Rust Windows target',
    Boolean(host && installedTargets?.split(/\r?\n/).includes(host)),
    installedTargets ?? '无法读取已安装 Rust targets',
  )

  const vswhereCandidates = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
  ].filter(Boolean)
  const vswhere = vswhereCandidates.find((candidate) => existsSync(candidate))
  const vsInstall = vswhere
    ? run(vswhere, [
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
      ])
    : null
  add(
    'Microsoft C++ Build Tools',
    Boolean(vsInstall),
    vsInstall ?? '未检测到“使用 C++ 的桌面开发”工作负载',
  )

  const webViewRoots = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'EdgeWebView', 'Application'),
    join(process.env.ProgramFiles ?? '', 'Microsoft', 'EdgeWebView', 'Application'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'EdgeWebView', 'Application'),
  ].filter(Boolean)
  const hasWebView = webViewRoots.some((candidate) => existsSync(candidate))
  add(
    'WebView2 Runtime',
    hasWebView,
    hasWebView ? '已检测到 Edge WebView2 运行目录' : '未在常见目录检测到；Windows 10/11 通常已安装',
    false,
  )
} else {
  add(
    'Windows installer host',
    false,
    `当前系统为 ${process.platform}；正式 NSIS .exe 建议在 Windows 上生成`,
    false,
  )
}

let unicodeRoot = null
try {
  unicodeRoot = mkdtempSync(join(tmpdir(), '排版助手-'))
  const source = join(unicodeRoot, '测试工程.figgrid.tmp')
  const target = join(unicodeRoot, '测试工程.figgrid')
  writeFileSync(source, Buffer.from('figgrid-desktop-doctor'))
  renameSync(source, target)
  add('Unicode path I/O', existsSync(target), target)
} catch (error) {
  add('Unicode path I/O', false, error instanceof Error ? error.message : '中文路径读写失败')
} finally {
  if (unicodeRoot) rmSync(unicodeRoot, { recursive: true, force: true })
}

try {
  const stats = statfsSync(process.cwd())
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  add(
    'Free disk space',
    freeBytes >= 3 * 1024 * 1024 * 1024,
    `${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB 可用`,
    false,
  )
} catch {
  add('Free disk space', false, '无法读取可用磁盘空间', false)
}

const width = Math.max(...checks.map((item) => item.name.length))
for (const item of checks) {
  const icon = item.ok ? 'OK ' : item.required ? 'ERR' : 'WARN'
  console.log(`${icon}  ${item.name.padEnd(width)}  ${item.detail}`)
}

const failed = checks.filter((item) => item.required && !item.ok)
if (failed.length > 0) {
  console.error(`\n环境检查未通过：${failed.map((item) => item.name).join('、')}`)
  process.exitCode = 1
} else {
  console.log('\n环境检查通过，可运行 npm run desktop:dev 或 npm run desktop:build:windows。')
}
