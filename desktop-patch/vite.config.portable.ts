import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// 便携网页版：产出可以直接双击 index.html 使用的一套文件，无需服务器。
//
// 为了在 file:// 下正常工作，做了三处偏离常规的设置：
//
// 1. base: './'
//    默认打包会生成 /assets/xxx.js 这样的绝对路径，双击打开时会到硬盘根目录
//    去找，必然 404。改成相对路径才能找到。
//
// 2. 输出格式 iife、禁用代码分包
//    浏览器出于安全策略，禁止 file:// 页面加载 ES 模块（会报 CORS 错误）。
//    传统脚本则不受限制，所以打成单个传统脚本。
//
// 3. 工程存储换成纯内存实现
//    Chrome / Edge 禁止 file:// 页面使用浏览器数据库（IndexedDB）。
//    便携版因此不保留工程，关闭即清空 —— 用户可用"导出工程文件"手动留存。

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^(.*)\/lib\/storage$/,
        replacement: fileURLToPath(new URL('./src/lib/storage-memory.ts', import.meta.url)),
      },
    ],
  },
  build: {
    outDir: 'dist-portable',
    target: 'es2020',
    assetsInlineLimit: 100_000_000, // 图标等小资源全部内联，减少散落文件
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
})
