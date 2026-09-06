import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
// Node >= 18.20.2（CVE-2024-27980）在 Windows 上拒绝直接 spawn .cmd，
// 必须显式走 shell；参数均为字面量，无注入面。
const npmExecpath = process.env.npm_execpath
const useNodeEntry = npmExecpath && npmExecpath.endsWith('.js')
const npmResult = useNodeEntry
  ? spawnSync(
      process.execPath,
      [npmExecpath, 'install', '--package-lock-only', '--ignore-scripts'],
      { stdio: 'inherit', cwd: root },
    )
  : spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--package-lock-only', '--ignore-scripts'],
      { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' },
    )
if (npmResult.error) {
  console.error(`无法运行 npm：${npmResult.error.message}`)
  process.exit(1)
}
if (npmResult.status !== 0) process.exit(npmResult.status ?? 1)

const cargoCommand = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const cargoResult = spawnSync(
  cargoCommand,
  ['generate-lockfile', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml')],
  { stdio: 'inherit' },
)
if (cargoResult.error) {
  console.error(`无法运行 Cargo：${cargoResult.error.message}`)
  process.exit(1)
}
if (cargoResult.status !== 0) process.exit(cargoResult.status ?? 1)

const files = ['package-lock.json', join('src-tauri', 'Cargo.lock')]
const sealed = {}
for (const relative of files) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    console.error(`锁文件生成后仍缺失：${relative}`)
    process.exit(1)
  }
  const bytes = readFileSync(path)
  sealed[relative.replaceAll('\\', '/')] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}
writeFileSync(
  join(root, 'desktop-lockfiles.sha256.json'),
  `${JSON.stringify({ schema: 1, files: sealed }, null, 2)}\n`,
)
console.log('npm/Cargo lockfile 已生成并写入 desktop-lockfiles.sha256.json 封印。')
