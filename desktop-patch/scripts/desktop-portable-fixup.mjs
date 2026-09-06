// 便携网页版的收尾处理。
//
// Vite 产出的 index.html 里脚本标签带 type="module"，而浏览器禁止 file://
// 页面加载 ES 模块。这里把它改成传统脚本标签，并注入一条提醒横幅，
// 告诉用户便携版不保留工程。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const outDir = resolve(process.argv[2] ?? 'dist-portable')
const indexPath = join(outDir, 'index.html')

if (!existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}，请先运行便携版构建。`)
  process.exit(1)
}

let html = readFileSync(indexPath, 'utf8')

// 1. 去掉 type="module"，改用传统脚本
const before = html
html = html.replace(/<script\s+type="module"\s+crossorigin\s+/g, '<script defer ')
html = html.replace(/<script\s+type="module"\s+/g, '<script defer ')
html = html.replace(/\s+crossorigin(?=[\s>])/g, '')
if (html === before && /type="module"/.test(html)) {
  console.error('未能改写脚本标签，便携版在 file:// 下将无法运行。')
  process.exit(1)
}

// 2. modulepreload 在传统脚本模式下无意义，移除以免报错
html = html.replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '')

// 3. 注入提醒横幅：便携版不保留工程
const banner = `
    <div id="portable-notice" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#1f2937;color:#f9fafb;font:14px/1.6 system-ui,-apple-system,'Microsoft YaHei',sans-serif;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;box-shadow:0 -2px 12px rgba(0,0,0,.18)">
      <span>便携版不会保存工程，关闭窗口后内容即清空。需要留存请点「导出工程文件」，下次拖回窗口即可继续编辑。</span>
      <button type="button" onclick="document.getElementById('portable-notice').remove()" style="background:#374151;color:#f9fafb;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;flex:0 0 auto">知道了</button>
    </div>
`
html = html.replace('</body>', `${banner}  </body>`)

writeFileSync(indexPath, html)

const files = readdirSync(outDir)
console.log(`便携版已就绪：${outDir}`)
console.log(`  文件 ${files.length} 个：${files.join('、')}`)
console.log('  双击 index.html 即可使用。')
