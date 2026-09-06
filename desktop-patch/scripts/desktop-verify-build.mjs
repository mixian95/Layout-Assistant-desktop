import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = process.cwd()
const configuredTarget = process.env.CARGO_TARGET_DIR
const searchRoots = [
  configuredTarget ? resolve(configuredTarget) : null,
  join(root, 'src-tauri', 'target'),
].filter(Boolean)

function walk(dir, depth = 0) {
  if (!existsSync(dir) || depth > 8) return []
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walk(path, depth + 1))
    else if (entry.isFile() && /(?:setup|installer).*\.exe$/i.test(entry.name)) results.push(path)
    else if (entry.isFile() && /\.exe$/i.test(entry.name) && path.toLowerCase().includes(`${join('bundle', 'nsis').toLowerCase()}`)) results.push(path)
  }
  return results
}

const candidates = [...new Set(searchRoots.flatMap((dir) => walk(dir)))]
  .filter((path) => path.toLowerCase().includes('nsis'))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

if (!candidates.length) {
  console.error('未找到 NSIS 安装程序。请确认 tauri build --bundles nsis 已成功完成。')
  process.exit(1)
}

const installer = candidates[0]
const bytes = readFileSync(installer)
if (bytes.length < 100 * 1024) {
  console.error(`安装程序异常小：${bytes.length} bytes (${installer})`)
  process.exit(1)
}
const sha256 = createHash('sha256').update(bytes).digest('hex')
console.log(`OK  NSIS installer  ${installer}`)
console.log(`OK  Size            ${(bytes.length / 1024 / 1024).toFixed(2)} MB`)
console.log(`OK  SHA-256         ${sha256}`)
console.log(`OK  File            ${basename(installer)}`)
