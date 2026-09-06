// 生成可在 PowerPoint 中继续编辑的 .pptx。
//
// 刻意不引入 pptxgenjs：本项目所有依赖都是 `=` 精确固定的，为一个单页
// 幻灯片引入 ~1MB 的新依赖会削弱供应链约束。这里输出的结构极简单
// （一页、若干图片、若干文本框），是 OOXML 最容易写正确的情形。
//
// 产出的每个面板是独立图片对象、每个标签是真正的文本框，因此在
// PowerPoint 里可以拖动、缩放、替换图片、改文字与字号、叠加箭头注释。
// 这是单向导出：改完的 pptx 不能再导回本软件。

const EMU_PER_INCH = 914400
const MM_PER_INCH = 25.4

export function mmToEmu(mm: number): number {
  return Math.round((mm / MM_PER_INCH) * EMU_PER_INCH)
}

export interface PptxCrop {
  /** 四边裁掉的比例，0–1，相对源图尺寸。 */
  left: number
  top: number
  right: number
  bottom: number
}

export interface PptxImage {
  bytes: Uint8Array
  /** 目前只产出 png 与 jpeg；webp 在上层已转码。 */
  extension: 'png' | 'jpeg'
  name: string
  x: number
  y: number
  cx: number
  cy: number
  crop?: PptxCrop
}

export interface PptxText {
  text: string
  x: number
  y: number
  cx: number
  cy: number
  /** 磅值 */
  sizePt: number
  bold: boolean
  /** 六位十六进制，不带 # */
  color: string
  fontFace: string
  align: 'l' | 'r'
}

export interface PptxSpec {
  widthEmu: number
  heightEmu: number
  /** 六位十六进制；留空表示不铺底色（幻灯片保持默认白） */
  background?: string
  images: PptxImage[]
  texts: PptxText[]
  title: string
}

/** OOXML 规定幻灯片边长必须落在 1 英寸 ~ 56 英寸之间，超界 PowerPoint 直接拒绝打开。 */
export const MIN_SLIDE_EMU = 914400
export const MAX_SLIDE_EMU = 51206400

/**
 * 把幻灯片尺寸夹到合法区间，并返回需要同步施加到内容上的等比缩放系数。
 *
 * 只在物理尺寸本身荒谬时才会生效（小于 1 英寸或大于 56 英寸），
 * 例如"宽 500px @ 1200dpi"= 0.42 英寸。等比缩放保证版面不变形。
 */
export function slideScaleFactor(widthEmu: number, heightEmu: number): number {
  if (!Number.isFinite(widthEmu) || !Number.isFinite(heightEmu)) return 1
  if (widthEmu <= 0 || heightEmu <= 0) return 1
  const up = Math.max(1, MIN_SLIDE_EMU / widthEmu, MIN_SLIDE_EMU / heightEmu)
  const down = Math.min(1, MAX_SLIDE_EMU / widthEmu, MAX_SLIDE_EMU / heightEmu)
  return up > 1 ? up : down
}

/** srgbClr 必须是六位十六进制，否则 PowerPoint 拒绝打开整个文件。 */
function safeColor(value: string): string {
  const hex = (value ?? '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '111827'
}

/** 坐标必须是有限整数；NaN/Infinity 会写出非法 XML。 */
function emu(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(-MAX_SLIDE_EMU, Math.min(MAX_SLIDE_EMU, Math.round(value)))
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 裁剪比例 → OOXML 的千分之一百分比整数，并夹紧到合法范围。 */
function cropUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(99000, Math.round(value * 100000)))
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const NS_P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

function contentTypes(images: PptxImage[]): string {
  const extensions = new Set(images.map((image) => image.extension))
  const defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>']
  for (const extension of extensions) {
    const mime = extension === 'png' ? 'image/png' : 'image/jpeg'
    defaults.push(`<Default Extension="${extension}" ContentType="${mime}"/>`)
  }
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults.join('') +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '</Types>'
  )
}

const ROOT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  '</Relationships>'

function clampSlide(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_SLIDE_EMU
  return Math.round(Math.max(MIN_SLIDE_EMU, Math.min(MAX_SLIDE_EMU, value)))
}

function presentation(spec: PptxSpec): string {
  return (
    XML_DECL +
    `<p:presentation ${NS_P} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    `<p:sldSz cx="${clampSlide(spec.widthEmu)}" cy="${clampSlide(spec.heightEmu)}"/>` +
    `<p:notesSz cx="${clampSlide(spec.heightEmu)}" cy="${clampSlide(spec.widthEmu)}"/>` +
    '</p:presentation>'
  )
}

const PRESENTATION_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
  '</Relationships>'

/** 最小但完整的主题。PowerPoint 要求 12 色、两套字体、三套格式。 */
function theme(): string {
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="44546A"/>'],
    ['lt2', '<a:srgbClr val="E7E6E6"/>'],
    ['accent1', '<a:srgbClr val="4472C4"/>'],
    ['accent2', '<a:srgbClr val="ED7D31"/>'],
    ['accent3', '<a:srgbClr val="A5A5A5"/>'],
    ['accent4', '<a:srgbClr val="FFC000"/>'],
    ['accent5', '<a:srgbClr val="5B9BD5"/>'],
    ['accent6', '<a:srgbClr val="70AD47"/>'],
    ['hlink', '<a:srgbClr val="0563C1"/>'],
    ['folHlink', '<a:srgbClr val="954F72"/>'],
  ]
    .map(([name, value]) => `<a:${name}>${value}</a:${name}>`)
    .join('')

  const fill =
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const fillStyles = `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`
  const line =
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:prstDash val="solid"/></a:ln>'
  const lineStyles = `<a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>`
  const effect = '<a:effectStyle><a:effectLst/></a:effectStyle>'
  const effectStyles = `<a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst>`
  const bgStyles = `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>`

  return (
    XML_DECL +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Layout Assistant">' +
    '<a:themeElements>' +
    `<a:clrScheme name="Office">${colors}</a:clrScheme>` +
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    `<a:fmtScheme name="Office">${fillStyles}${lineStyles}${effectStyles}${bgStyles}</a:fmtScheme>` +
    '</a:themeElements>' +
    '</a:theme>'
  )
}

function emptySpTree(name: string): string {
  return (
    '<p:cSld><p:spTree>' +
    `<p:nvGrpSpPr><p:cNvPr id="1" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '</p:spTree></p:cSld>'
  )
}

function slideMaster(): string {
  return (
    XML_DECL +
    `<p:sldMaster ${NS_P}>` +
    emptySpTree('Master') +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>'
  )
}

const SLIDE_MASTER_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>'

function slideLayout(): string {
  return (
    XML_DECL +
    `<p:sldLayout ${NS_P} type="blank" preserve="1">` +
    emptySpTree('Layout') +
    '</p:sldLayout>'
  )
}

const SLIDE_LAYOUT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>'

function pictureXml(image: PptxImage, index: number, relId: string): string {
  const id = index + 2
  const crop = image.crop
  const srcRect =
    crop &&
    (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0)
      ? `<a:srcRect l="${cropUnit(crop.left)}" t="${cropUnit(crop.top)}" r="${cropUnit(crop.right)}" b="${cropUnit(crop.bottom)}"/>`
      : ''
  return (
    '<p:pic>' +
    `<p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(image.name)}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="0"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${relId}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(image.x)}" y="${Math.round(image.y)}"/>` +
    `<a:ext cx="${Math.max(1, emu(image.cx, 1))}" cy="${Math.max(1, emu(image.cy, 1))}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '</p:pic>'
  )
}

function textXml(item: PptxText, id: number): string {
  const size = Number.isFinite(item.sizePt)
    ? Math.max(100, Math.min(400000, Math.round(item.sizePt * 100)))
    : 1200
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(`标签 ${id}`)}"/>` +
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${Math.round(item.x)}" y="${Math.round(item.y)}"/>` +
    `<a:ext cx="${Math.max(1, emu(item.cx, 1))}" cy="${Math.max(1, emu(item.cy, 1))}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody>' +
    '<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:spAutoFit/></a:bodyPr>' +
    '<a:lstStyle/>' +
    `<a:p><a:pPr algn="${item.align}"/>` +
    `<a:r><a:rPr lang="en-US" sz="${size}" b="${item.bold ? 1 : 0}" dirty="0">` +
    `<a:solidFill><a:srgbClr val="${safeColor(item.color)}"/></a:solidFill>` +
    `<a:latin typeface="${escapeXml(item.fontFace)}"/></a:rPr>` +
    `<a:t>${escapeXml(item.text)}</a:t></a:r>` +
    '</a:p></p:txBody></p:sp>'
  )
}

function slide(spec: PptxSpec): string {
  const pictures = spec.images
    .map((image, index) => pictureXml(image, index, `rId${index + 1}`))
    .join('')
  const texts = spec.texts
    .map((item, index) => textXml(item, spec.images.length + index + 2))
    .join('')
  const background = spec.background
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${safeColor(spec.background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : ''

  return (
    XML_DECL +
    `<p:sld ${NS_P}>` +
    '<p:cSld>' +
    background +
    '<p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    pictures +
    texts +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sld>'
  )
}

function slideRels(spec: PptxSpec): string {
  const media = spec.images
    .map(
      (image, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.${image.extension}"/>`,
    )
    .join('')
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    media +
    `<Relationship Id="rId${spec.images.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    '</Relationships>'
  )
}

/** 返回 PPTX 包内每个部件的路径与内容，交由调用方压成 zip。 */
export function buildPptxParts(spec: PptxSpec): Record<string, Uint8Array> {
  const encoder = new TextEncoder()
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': encoder.encode(contentTypes(spec.images)),
    '_rels/.rels': encoder.encode(ROOT_RELS),
    'ppt/presentation.xml': encoder.encode(presentation(spec)),
    'ppt/_rels/presentation.xml.rels': encoder.encode(PRESENTATION_RELS),
    'ppt/theme/theme1.xml': encoder.encode(theme()),
    'ppt/slideMasters/slideMaster1.xml': encoder.encode(slideMaster()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': encoder.encode(SLIDE_MASTER_RELS),
    'ppt/slideLayouts/slideLayout1.xml': encoder.encode(slideLayout()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': encoder.encode(SLIDE_LAYOUT_RELS),
    'ppt/slides/slide1.xml': encoder.encode(slide(spec)),
    'ppt/slides/_rels/slide1.xml.rels': encoder.encode(slideRels(spec)),
  }
  spec.images.forEach((image, index) => {
    parts[`ppt/media/image${index + 1}.${image.extension}`] = image.bytes
  })
  return parts
}
