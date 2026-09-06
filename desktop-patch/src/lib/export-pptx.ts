// 把排好的版面导出成可在 PowerPoint 中继续编辑的 .pptx。
//
// 关键前提：布局引擎给出的全部是轴对齐矩形，没有旋转、斜切或嵌套变换，
// 因此每个元素都能一对一映射到 PPTX 的形状，不需要解析 SVG。
//
// 导出结果：每个面板是独立图片对象，每个标签是真正的文本框。
// 在 PowerPoint 里可以拖动、缩放、替换单张图、改标签文字与字号、叠加箭头注释。
// 这是单向导出，改完的 pptx 无法导回本软件。

import { zipSync } from 'fflate'
import type { FigureProjectV2, ImageAsset, SolvedLayout } from '../types'
import { getImageRenderRect, getPanelLabel } from './geometry'
import { getLabelPlacement } from './labels'
import { buildPptxParts, mmToEmu, slideScaleFactor } from './pptx'
import type { PptxImage, PptxText } from './pptx'
import { pixelsToMm } from './journal-presets'

const EMU_PER_POINT = 12700
/** 留出余量：桌面端 IPC 上限 256 MB，还要容纳 zip 结构与一次副本。 */
const MAX_EMBEDDED_BYTES = 180 * 1024 * 1024

/** CSS font-family 串取第一个字体名，PPTX 只认单个名字。 */
function primaryFontName(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? 'Arial'
  return first.trim().replace(/^["']|["']$/g, '') || 'Arial'
}

function hexColor(value: string): string {
  const hex = value.replace('#', '').trim()
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase()
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex
      .split('')
      .map((character) => character + character)
      .join('')
      .toUpperCase()
  }
  return '111827'
}

/** PowerPoint 对 WebP 的支持不可靠，统一转成 PNG。 */
async function toPptxImage(
  asset: ImageAsset,
): Promise<{ bytes: Uint8Array; extension: 'png' | 'jpeg' }> {
  if (asset.mime === 'image/png') {
    return { bytes: new Uint8Array(await asset.blob.arrayBuffer()), extension: 'png' }
  }
  if (asset.mime === 'image/jpeg') {
    return { bytes: new Uint8Array(await asset.blob.arrayBuffer()), extension: 'jpeg' }
  }

  const bitmap = await createImageBitmap(asset.blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法转码 WebP 图片。')
    context.drawImage(bitmap, 0, 0)
    const converted = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('WebP 转码失败。'))),
        'image/png',
      )
    })
    return { bytes: new Uint8Array(await converted.arrayBuffer()), extension: 'png' }
  } finally {
    bitmap.close()
  }
}

export async function createPptxBlob(
  project: FigureProjectV2,
  solved: SolvedLayout,
  outputWidthPx: number,
  dpi: number,
): Promise<Blob> {
  // 幻灯片尺寸取图的真实物理尺寸，这样在 PowerPoint 里 1:1 就是投稿尺寸
  const widthMm = pixelsToMm(outputWidthPx, dpi)
  const heightMm = (solved.height / solved.width) * widthMm
  // OOXML 要求幻灯片边长在 1~56 英寸之间。像"500px @ 1200dpi"(=0.42 英寸)
  // 或超宽横排图在高 dpi 下的高度都会越界，越界的文件 PowerPoint 直接拒绝打开。
  // 这里等比放大/缩小到合法区间，版面比例不受影响。
  const factor = slideScaleFactor(mmToEmu(widthMm), mmToEmu(heightMm))
  const widthEmu = Math.round(mmToEmu(widthMm) * factor)
  const heightEmu = Math.round(mmToEmu(heightMm) * factor)
  if (!Number.isFinite(widthEmu) || !Number.isFinite(heightEmu) || solved.width <= 0) {
    throw new Error('当前布局尺寸异常，无法导出 PPTX。')
  }
  const scale = widthEmu / solved.width // 画布坐标 → EMU

  const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
  const images: PptxImage[] = []
  const texts: PptxText[] = []

  for (const frame of solved.frames) {
    const asset = assetMap.get(frame.assetId)
    const panel = project.panels[frame.assetId]
    if (!asset || !panel) continue

    const rect = getImageRenderRect(frame, asset, panel)

    // 可见区域 = 绘制矩形 ∩ 面板框。
    // 这样同时覆盖两种情况：图比框大（需要裁剪）、图比框小（留白，不裁剪）。
    const visLeft = Math.max(frame.x, rect.x)
    const visTop = Math.max(frame.y, rect.y)
    const visRight = Math.min(frame.x + frame.width, rect.x + rect.width)
    const visBottom = Math.min(frame.y + frame.height, rect.y + rect.height)
    if (visRight <= visLeft || visBottom <= visTop) continue
    // rect 宽高为 0 会让下面的裁剪比例变成 NaN/Infinity，写出非法 XML
    if (!(rect.width > 0) || !(rect.height > 0)) continue

    const { bytes, extension } = await toPptxImage(asset)
    images.push({
      bytes,
      extension,
      name: asset.name || `面板 ${images.length + 1}`,
      x: visLeft * scale,
      y: visTop * scale,
      cx: (visRight - visLeft) * scale,
      cy: (visBottom - visTop) * scale,
      crop: {
        left: (visLeft - rect.x) / rect.width,
        top: (visTop - rect.y) / rect.height,
        right: (rect.x + rect.width - visRight) / rect.width,
        bottom: (rect.y + rect.height - visBottom) / rect.height,
      },
    })

    const index = project.panelOrder.indexOf(frame.assetId)
    const label = getPanelLabel(
      index,
      project.style.labelMode,
      project.style.labelParentheses,
    )
    if (!label || panel.hiddenLabel) continue

    const placement = getLabelPlacement(frame, project.style)
    const sizePt = (project.style.labelSize * scale) / EMU_PER_POINT
    // placement.y 是基线；文本框上沿约在基线上方一个 ascent 处
    const boxTop = (placement.y - project.style.labelSize * 0.8) * scale
    const boxWidth = project.style.labelSize * 2.4 * scale
    const boxHeight = project.style.labelSize * 1.35 * scale
    const align = placement.textAnchor === 'start' ? 'l' : 'r'

    texts.push({
      text: label,
      x: align === 'l' ? placement.x * scale : placement.x * scale - boxWidth,
      y: boxTop,
      cx: boxWidth,
      cy: boxHeight,
      sizePt,
      bold: project.style.labelWeight >= 600,
      color: hexColor(project.style.labelColor),
      fontFace: primaryFontName(placement.fontFamily),
      align,
    })
  }

  // WebP 转码成 PNG 后体积可能膨胀数倍，而桌面端 IPC 有 256 MB 上限。
  // 在这里提前拦下并给出可操作的提示，胜过让保存在 Rust 侧以"工程文件超过
  // 256 MB"这种与 PPTX 无关的错误失败。
  const embeddedBytes = images.reduce((sum, image) => sum + image.bytes.length, 0)
  if (embeddedBytes > MAX_EMBEDDED_BYTES) {
    throw new Error(
      `嵌入图片共 ${Math.round(embeddedBytes / 1024 / 1024)} MB，超过 ${
        MAX_EMBEDDED_BYTES / 1024 / 1024
      } MB 上限。WebP 图片转存为 PNG 后会明显变大，建议先把素材转成 JPEG 或缩小尺寸。`,
    )
  }

  const parts = buildPptxParts({
    widthEmu,
    heightEmu,
    background:
      project.style.background === 'transparent' ? undefined : 'FFFFFF',
    images,
    texts,
    title: project.title,
  })

  // mtime 固定，理由同 .figgrid：让同一份工程的导出结果可复现。
  // 必须是本地时间字面量（无 Z），否则 fflate 在 UTC 以西时区会抛
  // invalid zip date。
  const zipped = zipSync(parts, {
    level: 6,
    mtime: new Date('1980-01-01T00:00:00'),
  })
  return new Blob([zipped], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })
}
