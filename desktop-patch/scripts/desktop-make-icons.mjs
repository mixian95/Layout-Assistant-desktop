// 生成 Tauri Windows 打包所需的图标，全部用代码产出，仓库里不需要任何二进制资源。
//
// 为什么需要：tauri-build 在 Windows 上必须有 icons/icon.ico 才能生成
// Windows Resource 文件，缺失会导致 `cargo test` / `tauri build` 直接失败：
//     `icons/icon.ico` not found; required for generating a Windows Resource file
//
// 产出（与 tauri.conf.json 的 bundle.icon 一一对应）：
//   icons/32x32.png
//   icons/128x128.png
//   icons/128x128@2x.png   (256x256)
//   icons/icon.ico         (16/32/48/64/128/256 多尺寸，经典 BMP 格式)
//
// 图案：深色底 + 六宫格白块，对应"论文图片排版助手"的六宫格布局。

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BG = [24, 26, 31] // 深灰蓝底
const FG = [246, 247, 245] // 与 meta-theme-color 呼应的米白

/** 画一帧 size×size 的 RGBA 像素（六宫格：3 列 × 2 行） */
function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const pad = Math.max(1, Math.round(size * 0.14))
  const gap = Math.max(1, Math.round(size * 0.06))
  const cols = 3
  const rows = 2
  const cellW = (size - pad * 2 - gap * (cols - 1)) / cols
  const cellH = (size - pad * 2 - gap * (rows - 1)) / rows
  const radius = Math.max(0, Math.round(Math.min(cellW, cellH) * 0.18))

  const inCell = (x, y) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = pad + c * (cellW + gap)
        const y0 = pad + r * (cellH + gap)
        const x1 = x0 + cellW
        const y1 = y0 + cellH
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue
        // 圆角
        const dx = Math.min(x - x0, x1 - 1 - x)
        const dy = Math.min(y - y0, y1 - 1 - y)
        if (dx < radius && dy < radius) {
          const ox = radius - dx
          const oy = radius - dy
          if (ox * ox + oy * oy > radius * radius) continue
        }
        return true
      }
    }
    return false
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const color = inCell(x, y) ? FG : BG
      px[i] = color[0]
      px[i + 1] = color[1]
      px[i + 2] = color[2]
      px[i + 3] = 255
    }
  }
  return px
}

// ---------- PNG ----------

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function toPng(size, px) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // 每行前加 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- ICO（经典 BMP 格式，兼容性最好） ----------

function bmpFrame(size, px) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND 两张图，高度翻倍
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  // 自下而上的 BGRA
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = (y * size + x) * 4
      xor[d] = px[s + 2]
      xor[d + 1] = px[s + 1]
      xor[d + 2] = px[s]
      xor[d + 3] = px[s + 3]
    }
  }
  // AND 掩码：全不透明，但行需按 4 字节对齐
  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)
  return Buffer.concat([header, xor, and])
}

function toIco(sizes) {
  const frames = sizes.map((size) => ({ size, data: bmpFrame(size, render(size)) }))
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(frames.length, 4)
  let offset = 6 + frames.length * 16
  const entries = []
  for (const frame of frames) {
    const e = Buffer.alloc(16)
    e[0] = frame.size >= 256 ? 0 : frame.size
    e[1] = frame.size >= 256 ? 0 : frame.size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(frame.data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += frame.data.length
    entries.push(e)
  }
  return Buffer.concat([dir, ...entries, ...frames.map((f) => f.data)])
}

// ---------- 入口 ----------

export function generateIcons(iconsDir, { force = false } = {}) {
  mkdirSync(iconsDir, { recursive: true })
  const targets = [
    ['32x32.png', () => toPng(32, render(32))],
    ['128x128.png', () => toPng(128, render(128))],
    ['128x128@2x.png', () => toPng(256, render(256))],
    ['icon.ico', () => toIco([16, 32, 48, 64, 128, 256])],
  ]
  const written = []
  for (const [name, make] of targets) {
    const path = join(iconsDir, name)
    if (!force && existsSync(path)) continue
    writeFileSync(path, make())
    written.push(name)
  }
  return written
}

// 允许直接运行：node scripts/desktop-make-icons.mjs [目录]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2] ?? join(dirname(process.argv[1]), '..', 'src-tauri', 'icons')
  const written = generateIcons(target, { force: true })
  console.log(`已生成图标于 ${target}：${written.join(', ')}`)
}
