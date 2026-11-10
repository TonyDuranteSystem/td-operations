/**
 * Scan document: the few pieces that need a real browser (pictures, canvases, the camera). Kept thin on purpose —
 * everything with logic in it lives in the pure files next to this one and is tested there.
 */
import { applyLook, type ScanLook } from './enhance'
import { clampQuad, outputSize, warpPerspective, type Quad, type Raster } from './geometry'

export interface DecodedPicture { raster: Raster; width: number; height: number }

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

/** Never larger than `maxLong` on the long side (a phone camera picture is 12 megapixels: far more than a page needs). */
export function fitSize(w: number, h: number, maxLong: number): { width: number; height: number } {
  const k = Math.min(1, maxLong / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not save the picture.'))), 'image/jpeg', quality))
}

/** Reads a photo file (the iPhone turns it upright for us when it is drawn from an <img>) into pixels, shrunk to `maxLong`. */
export async function decodePicture(file: Blob, maxLong: number): Promise<DecodedPicture> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('This picture could not be read.')); img.src = url })
    const { width, height } = fitSize(img.naturalWidth, img.naturalHeight, maxLong)
    const canvas = newCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('This browser cannot read the picture.')
    ctx.drawImage(img, 0, 0, width, height)
    const data = ctx.getImageData(0, 0, width, height)
    return { raster: { data: data.data, width, height }, width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Saves pixels as a JPEG. */
export async function rasterToJpegBlob(raster: Raster, quality = 0.9): Promise<Blob> {
  const canvas = newCanvas(raster.width, raster.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot save the picture.')
  ctx.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0)
  return canvasToBlob(canvas, quality)
}

/** The current camera picture as pixels and as a saved JPEG. */
export async function grabVideoFrame(video: HTMLVideoElement, maxLong: number): Promise<{ raster: Raster; blob: Blob }> {
  const { width, height } = fitSize(video.videoWidth, video.videoHeight, maxLong)
  const canvas = newCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('This browser cannot read the camera.')
  ctx.drawImage(video, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height)
  return { raster: { data: data.data, width, height }, blob: await canvasToBlob(canvas, 0.9) }
}

/** A small look at the camera for the page finder (about 160 pixels wide). Reuses one canvas. */
export function makeSmallLooker(maxWidth = 160) {
  let canvas: HTMLCanvasElement | null = null
  return (video: HTMLVideoElement): Raster | null => {
    if (!video.videoWidth || !video.videoHeight) return null
    const w = Math.max(1, Math.round(Math.min(maxWidth, video.videoWidth)))
    const h = Math.max(1, Math.round((w * video.videoHeight) / video.videoWidth))
    if (!canvas || canvas.width !== w || canvas.height !== h) canvas = newCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    return { data: data.data, width: w, height: h }
  }
}

export interface RenderedPage { blob: Blob; width: number; height: number }

/** Straightens the page inside `corners`, gives it its look, and saves it as a JPEG. */
export async function renderPage(source: Raster, corners: Quad, look: ScanLook, maxLong: number, quality: number): Promise<RenderedPage> {
  const q = clampQuad(corners, source.width, source.height)
  const size = outputSize(q, maxLong)
  const warped = warpPerspective(source, q, size.width, size.height)
  const done = applyLook(warped, look)
  const canvas = newCanvas(done.width, done.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw the page.')
  ctx.putImageData(new ImageData(done.data as Uint8ClampedArray<ArrayBuffer>, done.width, done.height), 0, 0)
  return { blob: await canvasToBlob(canvas, quality), width: done.width, height: done.height }
}

/** Lets the screen breathe between heavy steps, so a spinner can turn. */
export const nextFrame = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export type CameraProblem = 'denied' | 'unsupported' | 'failed'

/** Opens the back camera. Throws a CameraProblem string. */
export async function openBackCamera(): Promise<MediaStream> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md || typeof md.getUserMedia !== 'function') throw 'unsupported' satisfies CameraProblem
  try {
    return await md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw 'denied' satisfies CameraProblem
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotSupportedError') throw 'unsupported' satisfies CameraProblem
    throw 'failed' satisfies CameraProblem
  }
}
