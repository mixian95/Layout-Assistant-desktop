// 位图容器层：给 PNG 写入 dpi 元数据，以及生成基线 TIFF。
//
// 本模块**不依赖 DOM**，全部是纯字节操作，因此可以在 Node 下直接跑单元测试。
//
// 为什么需要：canvas.toBlob() 产出的 PNG 不含 pHYs 数据块，Illustrator、Word
// 和多数投稿系统会把它当作 72 dpi。图其实够清晰，却会因为元数据不达标被退稿。

const MM_PER_INCH = 25.4

// ---------------------------------------------------------------- PNG pHYs

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** dpi 必须落在合理区间：NaN/Infinity/负数会让 setUint32 回绕成垃圾值。 */
function safeDpi(dpi: number): number {
  if (!Number.isFinite(dpi)) return 300
  return Math.max(1, Math.min(20000, Math.round(dpi)))
}

export function dpiToPixelsPerMetre(dpi: number): number {
  return Math.round(safeDpi(dpi) / (MM_PER_INCH / 1000))
}

/**
 * 在 PNG 的 IHDR 之后插入 pHYs 数据块，声明物理分辨率。
 * 若已存在 pHYs 则替换，保证幂等。
 */
export function setPngDpi(source: Uint8Array, dpi: number): Uint8Array {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (source[i] !== PNG_SIGNATURE[i]) {
      throw new Error('不是有效的 PNG 数据。')
    }
  }

  const ppm = dpiToPixelsPerMetre(dpi)
  const chunk = new Uint8Array(21) // 4 长度 + 4 类型 + 9 数据 + 4 CRC
  const view = new DataView(chunk.buffer)
  view.setUint32(0, 9)
  chunk[4] = 0x70 // p
  chunk[5] = 0x48 // H
  chunk[6] = 0x59 // Y
  chunk[7] = 0x73 // s
  view.setUint32(8, ppm)
  view.setUint32(12, ppm)
  chunk[16] = 1 // 单位 = 米
  view.setUint32(17, crc32(chunk.subarray(4, 17)))

  // 逐块扫描，定位 IHDR 结尾并剔除既有 pHYs
  const pieces: Uint8Array[] = [source.subarray(0, 8)]
  let offset = 8
  let inserted = false
  let sawEnd = false
  const reader = new DataView(source.buffer, source.byteOffset, source.byteLength)

  while (offset + 8 <= source.length) {
    const length = reader.getUint32(offset)
    const type = String.fromCharCode(
      source[offset + 4],
      source[offset + 5],
      source[offset + 6],
      source[offset + 7],
    )
    const total = 12 + length
    if (offset + total > source.length) break

    if (type !== 'pHYs') {
      pieces.push(source.subarray(offset, offset + total))
    }
    if (type === 'IHDR') {
      pieces.push(chunk)
      inserted = true
    }
    offset += total
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }

  if (!inserted) throw new Error('PNG 缺少 IHDR，无法写入分辨率。')
  // 扫描必须一直走到 IEND。中途因长度越界而 break，说明源数据被截断，
  // 此时若照常输出会得到一个"有头没身子"的 PNG —— 静默丢图比报错糟糕得多。
  if (!sawEnd) throw new Error('PNG 数据不完整，无法写入分辨率。')

  const size = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const result = new Uint8Array(size)
  let cursor = 0
  for (const piece of pieces) {
    result.set(piece, cursor)
    cursor += piece.length
  }
  return result
}

/** 读回 PNG 的 dpi，供测试与校验使用；没有 pHYs 时返回 null。 */
export function readPngDpi(source: Uint8Array): number | null {
  const reader = new DataView(source.buffer, source.byteOffset, source.byteLength)
  let offset = 8
  while (offset + 8 <= source.length) {
    const length = reader.getUint32(offset)
    const type = String.fromCharCode(
      source[offset + 4],
      source[offset + 5],
      source[offset + 6],
      source[offset + 7],
    )
    if (type === 'pHYs') {
      if (source[offset + 16] !== 1) return null
      const ppm = reader.getUint32(offset + 8)
      return Math.round(ppm * (MM_PER_INCH / 1000))
    }
    offset += 12 + length
    if (type === 'IEND') break
  }
  return null
}

// ---------------------------------------------------------------- TIFF

interface TiffEntry {
  tag: number
  type: number
  count: number
  /** 值 ≤ 4 字节时内联；否则先占位，稍后回填偏移。 */
  inline?: number
  payload?: Uint8Array
}

const TYPE_SHORT = 3
const TYPE_LONG = 4
const TYPE_RATIONAL = 5

/**
 * 生成基线（baseline）未压缩 TIFF。
 *
 * 选择未压缩而非 LZW：baseline TIFF 兼容性最好，任何投稿系统、
 * Illustrator、ImageJ 都能直接读；代价是文件较大。
 *
 * @param rgba   画布的 RGBA 原始像素，长度必须为 width*height*4
 * @param opaque true 时丢弃 alpha 通道输出 3 通道（体积小 25%，且避免
 *               部分老旧阅读器对 ExtraSamples 处理不一致）
 */
export function encodeTiff(
  rgba: Uint8Array,
  width: number,
  height: number,
  dpi: number,
  opaque: boolean,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('画布尺寸无效，无法生成 TIFF。')
  }
  if (rgba.length !== width * height * 4) {
    throw new Error('像素数据长度与画布尺寸不符。')
  }

  const samples = opaque ? 3 : 4
  const stripBytes = width * height * samples
  const pixels = new Uint8Array(stripBytes)
  if (opaque) {
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      pixels[o] = rgba[i]
      pixels[o + 1] = rgba[i + 1]
      pixels[o + 2] = rgba[i + 2]
    }
  } else {
    pixels.set(rgba)
  }

  const bitsPerSample = new Uint8Array(samples * 2)
  const bitsView = new DataView(bitsPerSample.buffer)
  for (let i = 0; i < samples; i++) bitsView.setUint16(i * 2, 8, true)

  const rational = (numerator: number) => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, safeDpi(numerator), true)
    view.setUint32(4, 1, true)
    return bytes
  }

  // IFD 条目必须按 tag 升序排列
  const entries: TiffEntry[] = [
    { tag: 256, type: TYPE_LONG, count: 1, inline: width },
    { tag: 257, type: TYPE_LONG, count: 1, inline: height },
    { tag: 258, type: TYPE_SHORT, count: samples, payload: bitsPerSample },
    { tag: 259, type: TYPE_SHORT, count: 1, inline: 1 }, // 不压缩
    { tag: 262, type: TYPE_SHORT, count: 1, inline: 2 }, // RGB
    { tag: 273, type: TYPE_LONG, count: 1, inline: 0 }, // StripOffsets，稍后回填
    { tag: 277, type: TYPE_SHORT, count: 1, inline: samples },
    { tag: 278, type: TYPE_LONG, count: 1, inline: height },
    { tag: 279, type: TYPE_LONG, count: 1, inline: stripBytes },
    { tag: 282, type: TYPE_RATIONAL, count: 1, payload: rational(dpi) },
    { tag: 283, type: TYPE_RATIONAL, count: 1, payload: rational(dpi) },
    { tag: 296, type: TYPE_SHORT, count: 1, inline: 2 }, // 单位 = 英寸
  ]
  if (!opaque) {
    // ExtraSamples = 2（非预乘 alpha）
    const extra = new Uint8Array(2)
    new DataView(extra.buffer).setUint16(0, 2, true)
    entries.push({ tag: 338, type: TYPE_SHORT, count: 1, inline: 2 })
    entries.sort((a, b) => a.tag - b.tag)
  }

  const headerSize = 8
  const ifdSize = 2 + entries.length * 12 + 4
  let payloadSize = 0
  for (const entry of entries) {
    if (entry.payload && entry.payload.length > 4) payloadSize += entry.payload.length
  }
  const stripOffset = headerSize + ifdSize + payloadSize

  const output = new Uint8Array(stripOffset + stripBytes)
  const view = new DataView(output.buffer)

  // 头部：小端序
  output[0] = 0x49
  output[1] = 0x49
  view.setUint16(2, 42, true)
  view.setUint32(4, headerSize, true)

  view.setUint16(headerSize, entries.length, true)
  let cursor = headerSize + 2
  let payloadCursor = headerSize + ifdSize

  for (const entry of entries) {
    view.setUint16(cursor, entry.tag, true)
    view.setUint16(cursor + 2, entry.type, true)
    view.setUint32(cursor + 4, entry.count, true)

    if (entry.tag === 273) {
      view.setUint32(cursor + 8, stripOffset, true)
    } else if (entry.payload && entry.payload.length > 4) {
      view.setUint32(cursor + 8, payloadCursor, true)
      output.set(entry.payload, payloadCursor)
      payloadCursor += entry.payload.length
    } else if (entry.payload) {
      output.set(entry.payload, cursor + 8)
    } else if (entry.type === TYPE_SHORT) {
      view.setUint16(cursor + 8, entry.inline ?? 0, true)
    } else {
      view.setUint32(cursor + 8, entry.inline ?? 0, true)
    }
    cursor += 12
  }
  view.setUint32(cursor, 0, true) // 没有下一个 IFD

  output.set(pixels, stripOffset)
  return output
}
