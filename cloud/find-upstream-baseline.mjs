// 上游基线：验证器（不是搜索器）
//
// 两种模式，自动切换：
//
//   1. UPSTREAM_BASELINE.json 里 commit 已填 40 位 SHA
//      → 严格模式：checkout 该 commit，核对整树 hash 与 6 个文件，不符即 fail。
//        这是 H-1 的完整修复。
//
//   2. commit 为 null（首次运行）
//      → 自举模式：先试 origin/HEAD，不匹配再回溯历史；找到后把 SHA 打印出来
//        并写入 resolved-upstream.json（会随构建产物上传）。
//        把它填回 UPSTREAM_BASELINE.json 的 commit/tree 字段，下次就自动进入严格模式。
//
// 无论哪种模式，最终选中的 commit 与 tree 都会被记录，构建产物因此可追溯。

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoDir = resolve(process.argv[2] ?? '')
const baselinePath = resolve(process.argv[3] ?? '')
if (!repoDir || !baselinePath) {
  console.error('Usage: node find-upstream-baseline.mjs <repo-dir> <baseline-json>')
  process.exit(2)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const exactFiles = Object.entries(baseline.exactFiles ?? {})
if (!exactFiles.length) {
  console.error('UPSTREAM_BASELINE.json 没有 exactFiles，无法验证。')
  process.exit(2)
}

const git = (args, enc = null) =>
  execFileSync('git', args, {
    cwd: repoDir,
    encoding: enc,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 该 commit 的 6 个文件是否全部匹配 baseline */
function matches(commit, { verbose = false } = {}) {
  let bad = 0
  for (const [relative, expected] of exactFiles) {
    let actual
    try {
      actual = sha256(git(['show', `${commit}:${relative}`]))
    } catch {
      if (verbose) console.error(`  ${relative}: 该 commit 中不存在`)
      bad++
      continue
    }
    if (actual !== expected) {
      if (verbose) {
        console.error(`  ${relative}`)
        console.error(`    期望 ${expected}`)
        console.error(`    实际 ${actual}`)
      }
      bad++
    }
  }
  return bad === 0
}

const pinned = baseline.commit
let selected = null

// ---------- 模式 1：严格验证 ----------
if (typeof pinned === 'string' && /^[0-9a-f]{40}$/.test(pinned)) {
  console.log(`严格模式：验证固定的 commit ${pinned}`)
  try {
    git(['checkout', '--detach', pinned], 'utf8')
  } catch {
    console.error(`固定的 commit ${pinned} 在克隆的仓库中不存在。`)
    console.error('请确认 clone 时使用了 --no-single-branch（或完整克隆）。')
    process.exit(1)
  }
  const head = git(['rev-parse', 'HEAD'], 'utf8').trim()
  if (head !== pinned) {
    console.error(`HEAD ${head} 与固定值 ${pinned} 不符。`)
    process.exit(1)
  }
  if (!matches(pinned, { verbose: true })) {
    console.error('固定 commit 的文件内容与 baseline 不符。拒绝构建。')
    process.exit(1)
  }
  selected = pinned
} else {
  // ---------- 模式 2：自举 ----------
  console.log('自举模式：UPSTREAM_BASELINE.json 尚未固定 commit，正在解析…')

  const candidates = []
  for (const ref of ['origin/HEAD', 'origin/main', 'HEAD']) {
    try {
      candidates.push(git(['rev-parse', ref], 'utf8').trim())
    } catch {
      /* ref 不存在，跳过 */
    }
  }
  for (const commit of candidates) {
    if (matches(commit)) {
      selected = commit
      console.log('在当前分支顶端找到匹配。')
      break
    }
  }

  if (!selected) {
    console.log('顶端不匹配，回溯历史…')
    const commits = git(['rev-list', '--all'], 'utf8')
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean)
    for (const commit of commits) {
      if (matches(commit)) {
        selected = commit
        break
      }
    }
  }

  if (!selected) {
    console.error('\n没有任何 commit 的这些文件同时匹配 baseline。')
    console.error('与当前分支顶端的差异：')
    const head = git(['rev-parse', 'HEAD'], 'utf8').trim()
    matches(head, { verbose: true })
    console.error('\nbaseline 很可能是从一棵带未提交改动的工作树算出来的。')
    console.error('请用真实 commit 的内容重算 exactFiles。')
    process.exit(1)
  }

  git(['checkout', '--detach', selected], 'utf8')
}

// 守卫：检出到磁盘的内容必须与 git blob 完全一致。
// Windows 上 core.autocrlf=true 会静默把 LF 换成 CRLF，导致后续打补丁全线失败，
// 而报错会出现在下一个步骤，非常难定位。在这里就拦下来。
{
  const { readFileSync } = await import('node:fs')
  const bad = []
  for (const [relative] of exactFiles) {
    const blob = sha256(git(['show', `${selected}:${relative}`]))
    let disk
    try {
      disk = sha256(readFileSync(resolve(repoDir, relative)))
    } catch {
      bad.push(`${relative}（磁盘上不存在）`)
      continue
    }
    if (blob !== disk) bad.push(relative)
  }
  if (bad.length) {
    console.error('\n检出到磁盘的文件与 git 对象不一致：')
    for (const item of bad) console.error(`  - ${item}`)
    console.error('\n几乎可以肯定是行尾自动转换（core.autocrlf）。')
    console.error('请用以下方式克隆：')
    console.error('  git clone --config core.autocrlf=false --config core.eol=lf <url> app')
    process.exit(1)
  }
}

const tree = git(['rev-parse', 'HEAD^{tree}'], 'utf8').trim()

// 整树 hash 一并校验（如果已固定）——连补丁没改的文件也被锁住
if (baseline.tree && baseline.tree !== tree) {
  console.error(`整树 hash ${tree} 与固定值 ${baseline.tree} 不符。拒绝构建。`)
  process.exit(1)
}

writeFileSync(
  resolve(repoDir, '..', 'resolved-upstream.json'),
  `${JSON.stringify({ commit: selected, tree, resolvedAt: new Date().toISOString() }, null, 2)}\n`,
)

console.log(`\n已验证上游快照：`)
console.log(`  commit ${selected}`)
console.log(`  tree   ${tree}`)
if (!baseline.commit) {
  console.log('\n──────────────────────────────────────────────────────────')
  console.log('  下一步（一次性）：把上面两个值填进 UPSTREAM_BASELINE.json：')
  console.log(`      "commit": "${selected}",`)
  console.log(`      "tree": "${tree}",`)
  console.log('  填完后本脚本会自动切换到严格模式，构建即被真正锁定。')
  console.log('──────────────────────────────────────────────────────────')
}
