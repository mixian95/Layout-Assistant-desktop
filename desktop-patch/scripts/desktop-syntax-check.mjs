// 打完补丁后对生成的源码做真实语法解析。
//
// 存在的理由：apply-desktop.mjs 用模板字符串拼接代码，转义层数很容易多写或少写
// 一层。多一个反斜杠会生成 `text: \`x\`` 这种东西——文件看起来没问题，
// 直到 esbuild 在构建阶段报 `Syntax error "\``。那时候已经烧掉一整轮 CI 了。
//
// 这里用 TypeScript 自带的解析器在本地立刻抓出来。

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const repoDir = resolve(process.argv[2] ?? '.')

/** 补丁改动或新增的全部源码文件。 */
const TARGETS = [
  'src/App.tsx',
  'src/components/InspectorPanel.tsx',
  'src/components/ProjectsPage.tsx',
  'src/components/DesktopRecentProjects.tsx',
  'src/components/DesktopRecoveryPanel.tsx',
  'src/hooks/useDesktopAutosave.ts',
  'src/lib/desktop.ts',
  'src/lib/journal-presets.ts',
  'src/lib/raster-format.ts',
  'src/lib/export-formats.ts',
  'src/lib/pptx.ts',
  'src/lib/export-pptx.ts',
  'src/lib/project-file.ts',
  'src/lib/project.ts',
  'src/types.ts',
]

let failures = 0

function fail(file, message) {
  console.error(`  ✗ ${file}: ${message}`)
  failures++
}

// ---- 第一道：字符级体检，不依赖任何库 ----
// 生成的 TS/TSX 里出现 \` 或 \${ 几乎必然是转义写错，
// 因为正常代码不会需要在模板字符串外转义反引号。
for (const relative of TARGETS) {
  const path = join(repoDir, relative)
  if (!existsSync(path)) continue
  const source = readFileSync(path, 'utf8')
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\\`/.test(line) || /\\\$\{/.test(line)) {
      fail(relative, `第 ${index + 1} 行残留转义反斜杠：${line.trim().slice(0, 80)}`)
    }
  })
}

// ---- 第二道：交给 TypeScript 解析器 ----
// 只解析、不做类型检查，够快，而且能抓到所有语法错误。
let ts = null
try {
  const require = createRequire(join(repoDir, 'package.json'))
  ts = require('typescript')
} catch {
  console.log('  （未找到 typescript，跳过解析器检查；字符级检查已执行）')
}

if (ts) {
  for (const relative of TARGETS) {
    const path = join(repoDir, relative)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    const file = ts.createSourceFile(
      relative,
      source,
      ts.ScriptTarget.Latest,
      true,
      relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const diagnostics = file.parseDiagnostics ?? []
    for (const diagnostic of diagnostics.slice(0, 5)) {
      const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      fail(relative, `第 ${line + 1} 行 ${text}`)
    }
  }
}

if (failures) {
  console.error(`\n补丁后语法检查失败：${failures} 处。`)
  process.exit(1)
}
console.log('补丁后语法检查通过。')
