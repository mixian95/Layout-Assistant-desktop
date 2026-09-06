// 面向界面的导出封装：带 dpi 的 PNG、以及 TIFF。
//
// 刻意做成独立文件而不是改 export.ts：新增功能只走"新增文件"，
// 补丁对上游既有文件的改动越少，上游更新时锚点失效的风险越低。

import type { FigureProjectV2, SolvedLayout } from '../types'
import { createPngBlob, createSvgBlob } from './export'
import { encodeTiff, setPngDpi } from './raster-format'

const MAX_TIFF_PIXELS = 60_000_000

function loadSvgImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG 渲染失败。'))
    }
    image.src = url
  })
}

/** 导出高度按布局宽高比推算，和 export.ts 中的算法保持一致。 */
export function outputHeightFor(solved: SolvedLayout, outputWidth: number): number {
  return Math.round((solved.height / solved.width) * outputWidth)
}

/**
 * 生成 PNG，并写入物理分辨率（pHYs）。
 *
 * canvas.toBlob() 产出的 PNG 没有 pHYs，投稿系统与排版软件会按 72 dpi 处理，
 * 这是"图明明够清晰却被退稿"的常见原因。
 */
export async function createPngBlobWithDpi(
  project: FigureProjectV2,
  solved: SolvedLayout,
  outputWidth: number,
  dpi: number,
): Promise<Blob> {
  const blob = await createPngBlob(project, solved, outputWidth)
  const tagged = setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi)
  return new Blob([tagged], { type: 'image/png' })
}

/**
 * 生成基线未压缩 TIFF。Elsevier、IEEE、Wiley 等多家期刊只接收 TIFF。
 *
 * 背景为"透明"时输出 RGBA，否则先合成到白底再输出 RGB —— 后者体积小 25%，
 * 且避免部分投稿系统对带 alpha 的 TIFF 处理不一致。
 */
export async function createTiffBlob(
  project: FigureProjectV2,
  solved: SolvedLayout,
  outputWidth: number,
  dpi: number,
): Promise<Blob> {
  const outputHeight = outputHeightFor(solved, outputWidth)
  if (outputWidth * outputHeight > MAX_TIFF_PIXELS) {
    throw new Error('当前尺寸下 TIFF 过大，请降低导出宽度或 dpi。')
  }

  const transparent = project.style.background === 'transparent'
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建导出画布。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  if (!transparent) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, outputWidth, outputHeight)
  }
  const image = await loadSvgImage(await createSvgBlob(project, solved))
  context.drawImage(image, 0, 0, outputWidth, outputHeight)

  const pixels = context.getImageData(0, 0, outputWidth, outputHeight).data
  const tiff = encodeTiff(
    new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    outputWidth,
    outputHeight,
    dpi,
    !transparent,
  )
  return new Blob([tiff], { type: 'image/tiff' })
}

/** 预估 TIFF 体积，用于在界面上提前提示。 */
export function estimateTiffBytes(
  solved: SolvedLayout,
  outputWidth: number,
  transparent: boolean,
): number {
  const height = outputHeightFor(solved, outputWidth)
  return outputWidth * height * (transparent ? 4 : 3) + 4096
}
