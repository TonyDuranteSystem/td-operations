/**
 * TD Communication — design-tools client helpers (Phase 12).
 *
 * Browser-only (Canvas / Image / FileReader) utilities shared by the mockup
 * previewer and asset-kit tools. NOT unit-tested (DOM-dependent — the pure logic
 * lives in mockup-templates.ts / asset-kit.ts / color-tools.ts); covered by
 * sandbox browser QA.
 *
 * CORS discipline: a logo sourced from a deliverable is fetched through the
 * same-origin logo-bytes passthrough, then turned into a data: URL. A data: URL
 * never taints a canvas, so Export/Save (toBlob) always work.
 */

export interface LoadedLogo {
  /** data: URL — untainted, embeddable in SVG, and canvas-exportable. */
  dataUrl: string
  /** Base name (no extension), used for output filenames. */
  name: string
  width: number
  height: number
  /** True only when the source actually has transparent pixels. */
  hasAlpha: boolean
}

function stripExt(name: string): string {
  return (name || 'logo').replace(/\.[^.]+$/, '') || 'logo'
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new Error('Could not read the image.'))
    fr.readAsDataURL(blob)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load the image. Please try a PNG, JPG or SVG.'))
    img.src = src
  })
}

/** Intrinsic size, defaulting SVGs with no width/height to 512 so they raster. */
export function logoDims(img: HTMLImageElement): { w: number; h: number } {
  return { w: img.naturalWidth || 512, h: img.naturalHeight || 512 }
}

/** Sample pixels for any actual sub-255 alpha (not merely "has an alpha channel"). */
function detectAlpha(img: HTMLImageElement): boolean {
  const { w, h } = logoDims(img)
  const cap = 256
  const scale = Math.min(1, cap / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const ctx = c.getContext('2d')
  if (!ctx) return false
  ctx.drawImage(img, 0, 0, cw, ch)
  try {
    const { data } = ctx.getImageData(0, 0, cw, ch)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true
    }
  } catch {
    return false
  }
  return false
}

async function makeLogo(dataUrl: string, name: string): Promise<LoadedLogo> {
  const img = await loadImage(dataUrl)
  const { w, h } = logoDims(img)
  return { dataUrl, name: stripExt(name), width: w, height: h, hasAlpha: detectAlpha(img) }
}

/** Load a logo from a user-selected File (same-origin blob → data URL). */
export async function fileToLogo(file: File): Promise<LoadedLogo> {
  const dataUrl = await blobToDataUrl(file)
  return makeLogo(dataUrl, file.name)
}

/** Load a logo from an existing deliverable via the same-origin byte passthrough. */
export async function deliverableToLogo(
  enrollmentId: string,
  deliverableId: string,
  fileName: string,
): Promise<LoadedLogo> {
  const res = await fetch(
    `/api/td-communication/projects/${enrollmentId}/design-assets/logo-bytes?deliverableId=${encodeURIComponent(
      deliverableId,
    )}`,
  )
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load the logo.')
  }
  const blob = await res.blob()
  const dataUrl = await blobToDataUrl(blob)
  return makeLogo(dataUrl, fileName)
}

/* -------------------------------------------------------------------------- */
/* Canvas rendering (asset kit)                                                */
/* -------------------------------------------------------------------------- */

/** High-quality down-scale via successive halving to avoid aliasing. */
function drawContained(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const { w: iw, h: ih } = logoDims(img)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (dw >= iw && dh >= ih) {
    ctx.drawImage(img, dx, dy, dw, dh)
    return
  }
  let cur: HTMLCanvasElement = document.createElement('canvas')
  cur.width = iw
  cur.height = ih
  cur.getContext('2d')!.drawImage(img, 0, 0, iw, ih)
  let cw = iw
  let ch = ih
  while (cw * 0.5 > dw && ch * 0.5 > dh) {
    const nw = Math.max(1, Math.round(cw * 0.5))
    const nh = Math.max(1, Math.round(ch * 0.5))
    const next = document.createElement('canvas')
    next.width = nw
    next.height = nh
    const nctx = next.getContext('2d')!
    nctx.imageSmoothingEnabled = true
    nctx.imageSmoothingQuality = 'high'
    nctx.drawImage(cur, 0, 0, nw, nh)
    cur = next
    cw = nw
    ch = nh
  }
  ctx.drawImage(cur, 0, 0, cw, ch, dx, dy, dw, dh)
}

/** Render the logo into a target size, centred + contained, over an optional bg. */
export function renderLogoCanvas(
  img: HTMLImageElement,
  targetW: number,
  targetH: number,
  bgHex: string | null,
  pad = 0.12,
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = targetW
  c.height = targetH
  const ctx = c.getContext('2d')!
  if (bgHex) {
    ctx.fillStyle = bgHex
    ctx.fillRect(0, 0, targetW, targetH)
  }
  const boxW = targetW * (1 - pad * 2)
  const boxH = targetH * (1 - pad * 2)
  const { w: iw, h: ih } = logoDims(img)
  const scale = Math.min(boxW / iw, boxH / ih)
  const dw = iw * scale
  const dh = ih * scale
  drawContained(ctx, img, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh)
  return c
}

export function canvasToPngBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the image.'))), 'image/png')
  })
}

/* -------------------------------------------------------------------------- */
/* SVG → PNG (mockup export/save)                                              */
/* -------------------------------------------------------------------------- */

/** Rasterise an SVG string (with an embedded data-URL logo) to a PNG blob. */
export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, width, height)
    return await canvasToPngBlob(c)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* -------------------------------------------------------------------------- */
/* Saving to Deliverables (isolated route — no pipeline side-effect)           */
/* -------------------------------------------------------------------------- */

/** PUT a blob to a signed upload URL. */
async function putBlob(url: string, blob: Blob): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  if (!res.ok) throw new Error('Upload failed. Please try again.')
}

/**
 * Save a generated blob (mockup PNG / asset-kit ZIP) into the project's
 * Deliverables via the isolated design-assets route. Returns nothing on success,
 * throws with a surfaced server error (R099) on failure.
 */
export async function saveDesignAsset(
  enrollmentId: string,
  type: 'mockup' | 'asset_kit' | 'geometry',
  blob: Blob,
  fileName: string,
): Promise<void> {
  const urlRes = await fetch(
    `/api/td-communication/projects/${enrollmentId}/design-assets/upload-url`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, type }),
    },
  )
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the save. Please try again.')
  }
  const { signedUrl, path } = await urlRes.json()
  if (!signedUrl || !path) throw new Error('Could not start the save. Please try again.')

  await putBlob(signedUrl, blob)

  const recRes = await fetch(`/api/td-communication/projects/${enrollmentId}/design-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      file_url: path,
      file_name: fileName,
      file_size: blob.size,
      mime_type: blob.type || null,
    }),
  })
  if (!recRes.ok) {
    const d = await recRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not save the design asset.')
  }
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* -------------------------------------------------------------------------- */
/* Deliverable logo picker source                                              */
/* -------------------------------------------------------------------------- */

export interface ImageDeliverableOption {
  id: string
  file_name: string
  preview_url: string | null
  type: string
}

/** Fetch the enrollment's image deliverables (for the "use a deliverable" picker). */
export async function fetchImageDeliverables(
  enrollmentId: string,
): Promise<ImageDeliverableOption[]> {
  const res = await fetch(`/api/td-communication/projects/${enrollmentId}/deliverables`)
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  const rows = Array.isArray(data.deliverables) ? data.deliverables : []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows
    .filter((d: any) => {
      const mime = (d.mime_type || '').toLowerCase()
      const ext = (d.file_name || '').split('.').pop()?.toLowerCase() || ''
      return mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)
    })
    .map((d: any) => ({
      id: d.id,
      file_name: d.file_name,
      preview_url: d.preview_url ?? null,
      type: d.type,
    }))
}
