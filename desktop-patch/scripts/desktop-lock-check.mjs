import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const failures = []
const packageLockPath = join(root, 'package-lock.json')
const cargoLockPath = join(root, 'src-tauri', 'Cargo.lock')
const sealPath = join(root, 'desktop-lockfiles.sha256.json')

if (!existsSync(packageLockPath)) {
  failures.push('缺少 package-lock.json（运行 npm run desktop:lock）')
} else {
  const lock = JSON.parse(readFileSync(packageLockPath, 'utf8'))
  const rootPackage = lock.packages?.[''] ?? {}
  if (rootPackage.dependencies?.['@tauri-apps/api'] !== '2.11.1') {
    failures.push('package-lock.json 未锁定 @tauri-apps/api 2.11.1')
  }
  if (rootPackage.devDependencies?.['@tauri-apps/cli'] !== '2.11.4') {
    failures.push('package-lock.json 未锁定 @tauri-apps/cli 2.11.4')
  }
}

if (!existsSync(cargoLockPath)) {
  failures.push('缺少 src-tauri/Cargo.lock（运行 npm run desktop:lock）')
} else {
  const cargoLock = readFileSync(cargoLockPath, 'utf8')
  for (const [name, version] of [
    ['tauri', '2.11.5'],
    ['tauri-build', '2.6.3'],
    ['tauri-plugin-dialog', '2.7.2'],
    ['tauri-plugin-single-instance', '2.4.3'],
    ['serde', '1.0.228'],
    ['serde_json', '1.0.149'],
    ['urlencoding', '2.1.3'],
    ['sha2', '0.10.9'],
  ]) {
    if (!cargoLock.includes(`name = "${name}"\nversion = "${version}"`)) {
      failures.push(`Cargo.lock 未锁定 ${name} ${version}`)
    }
  }
}

if (!existsSync(sealPath)) {
  failures.push('缺少 desktop-lockfiles.sha256.json；运行 npm run desktop:lock 生成并封印锁文件')
} else {
  try {
    const seal = JSON.parse(readFileSync(sealPath, 'utf8'))
    for (const relative of ['package-lock.json', 'src-tauri/Cargo.lock']) {
      const path = join(root, ...relative.split('/'))
      const expected = seal.files?.[relative]?.sha256
      if (!expected || !existsSync(path)) continue
      const bytes = readFileSync(path)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== expected) failures.push(`${relative} 与已封印 SHA-256 不一致`)
    }
  } catch (error) {
    failures.push(`desktop-lockfiles.sha256.json 无法解析：${error instanceof Error ? error.message : error}`)
  }
}

if (failures.length) {
  console.error(`依赖锁定检查失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('依赖锁定与 SHA-256 封印检查通过。')
