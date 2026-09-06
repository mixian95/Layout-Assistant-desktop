// 期刊图幅预设：把"多少毫米宽"换算成导出像素宽度。
//
// 科研作者在投稿时想的是"这是 Nature 的双栏图"，而不是"我要 3000 像素"。
// 期刊排版规范给的是物理宽度（mm）与最低分辨率（dpi），两者相乘才是像素。
//
//     像素宽 = 毫米宽 / 25.4 × dpi
//
// ⚠️ 下列数值取自各期刊公开的作者指南，属于常见通行值，但期刊会改版，
//    不同刊系（如 Nature 子刊）也可能不同。正式投稿前请以目标期刊
//    当期的 Artwork / Figure Guidelines 为准。

export interface JournalPreset {
  id: string
  journal: string
  column: string
  widthMm: number
  note?: string
}

export const JOURNAL_PRESETS: JournalPreset[] = [
  { id: 'nature-1', journal: 'Nature', column: '单栏', widthMm: 89 },
  { id: 'nature-2', journal: 'Nature', column: '双栏', widthMm: 183 },
  { id: 'science-1', journal: 'Science', column: '单栏', widthMm: 55 },
  { id: 'science-2', journal: 'Science', column: '双栏', widthMm: 120 },
  { id: 'science-3', journal: 'Science', column: '通栏', widthMm: 183 },
  { id: 'cell-1', journal: 'Cell', column: '单栏', widthMm: 85 },
  { id: 'cell-2', journal: 'Cell', column: '双栏', widthMm: 114 },
  { id: 'cell-3', journal: 'Cell', column: '通栏', widthMm: 174 },
  { id: 'elsevier-1', journal: 'Elsevier', column: '单栏', widthMm: 90 },
  { id: 'elsevier-15', journal: 'Elsevier', column: '1.5 栏', widthMm: 140 },
  { id: 'elsevier-2', journal: 'Elsevier', column: '双栏', widthMm: 190 },
  { id: 'ieee-1', journal: 'IEEE', column: '单栏', widthMm: 88.9, note: '3.5 in' },
  { id: 'ieee-2', journal: 'IEEE', column: '双栏', widthMm: 181, note: '7.16 in' },
  { id: 'plos-1', journal: 'PLOS', column: '单栏', widthMm: 83 },
  { id: 'plos-2', journal: 'PLOS', column: '双栏', widthMm: 173 },
]

/** 常用投稿分辨率。300 是多数期刊的位图下限，600 用于含线条/文字的合成图。 */
export const DPI_PRESETS = [300, 600, 1200]

export const MIN_DPI = 72
export const MAX_DPI = 1200
export const DEFAULT_DPI = 300

const MM_PER_INCH = 25.4

export function mmToPixels(widthMm: number, dpi: number): number {
  return Math.round((widthMm / MM_PER_INCH) * dpi)
}

export function pixelsToMm(widthPx: number, dpi: number): number {
  return (widthPx / dpi) * MM_PER_INCH
}

export function findPreset(id: string | undefined): JournalPreset | undefined {
  if (!id) return undefined
  return JOURNAL_PRESETS.find((preset) => preset.id === id)
}

export function clampDpi(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DPI
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(value)))
}

/** 给定像素宽与 dpi，返回用于界面展示的物理尺寸文案。 */
export function describePhysicalSize(
  widthPx: number,
  heightPx: number,
  dpi: number,
): string {
  const w = pixelsToMm(widthPx, dpi)
  const h = pixelsToMm(heightPx, dpi)
  return `${w.toFixed(1)} × ${h.toFixed(1)} mm @ ${dpi} dpi`
}
