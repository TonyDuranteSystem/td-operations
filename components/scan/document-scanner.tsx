'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTalkI18n } from '@/components/talk/talk-i18n'
import { ScanCamera } from '@/components/scan/scan-camera'
import { ScanAdjust } from '@/components/scan/scan-adjust'
import { ScanPages } from '@/components/scan/scan-pages'
import type { ScanPage, ScanScreen } from '@/components/scan/scan-types'
import { DEFAULT_SCAN_LOOK, type ScanLook } from '@/lib/scan/enhance'
import { defaultQuad, scaleQuad, type Quad, type Raster } from '@/lib/scan/geometry'
import { detectPage, refineQuad, toSmallGray } from '@/lib/scan/detect-page'
import { decodePicture, nextFrame, rasterToJpegBlob, renderPage } from '@/lib/scan/browser'
import { buildPdf, type PdfPageInput } from '@/lib/scan/pdf'
import { MAX_SCAN_PAGES, canAddPage, cleanScanName, defaultScanName, movePage, removePage, scanFileName } from '@/lib/scan/session'

/** The rough outline, measured again on a bigger copy of the picture so the corners sit on the real page edges. */
function sharpen(raster: Raster, rough: Quad): Quad {
  const { gray, scale } = toSmallGray(raster, 1000)
  return scaleQuad(refineQuad(gray, scaleQuad(rough, scale)), 1 / scale)
}

/** Where the page is in a picture: the camera's own outline if it has one, else the page finder's answer, else a rectangle a little inside the picture to start from. */
function findCorners(raster: Raster, hint: Quad | null): Quad {
  if (hint) return sharpen(raster, hint)
  const { gray, scale } = toSmallGray(raster, 160)
  const f = detectPage(gray)
  return f ? sharpen(raster, scaleQuad(f.quad, 1 / scale)) : defaultQuad(raster.width, raster.height)
}

/**
 * "Scan document": a full-screen scanner. Camera -> adjust each page -> all the pages -> ONE PDF, handed to `onDone` like any
 * file the person had picked. Everything happens on the phone; nothing leaves it until the person sends the message.
 */
export function DocumentScanner({ onDone, onClose }: { onDone: (file: File) => void; onClose: () => void }) {
  const { t } = useTalkI18n()
  const [mounted, setMounted] = useState(false)
  const [screen, setScreen] = useState<ScanScreen>('camera')
  const [pages, setPages] = useState<ScanPage[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [returnTo, setReturnTo] = useState<'camera' | 'pages'>('camera')
  const [working, setWorking] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [defaultName] = useState(() => defaultScanName(new Date()))
  const [name, setName] = useState(defaultName)
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState(0)
  const pagesRef = useRef(pages); pagesRef.current = pages
  const lookRef = useRef<ScanLook>(DEFAULT_SCAN_LOOK) // the look the person last chose carries to the next page
  const insertAt = useRef<number | null>(null)
  const seq = useRef(0)

  useEffect(() => { setMounted(true) }, [])
  // no page scrolling behind the scanner; release every picture address when it closes
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev; pagesRef.current.forEach(p => URL.revokeObjectURL(p.previewUrl)) }
  }, [])

  const requestClose = useCallback(() => {
    if (pagesRef.current.length > 0) setConfirmClose(true)
    else onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmClose) setConfirmClose(false)
      else if (screen === 'camera') requestClose()
      else if (screen === 'pages' && !building) setScreen('camera')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [screen, confirmClose, building, requestClose])

  const current = pages.find(p => p.id === currentId) ?? null

  /** A new picture: find the page in it, straighten it, put it on the list. */
  const addPage = useCallback(async (raster: Raster, blob: Blob, hint: Quad | null): Promise<void> => {
    const corners = findCorners(raster, hint)
    const look = lookRef.current
    const rendered = await renderPage(raster, corners, look, 900, 0.8)
    const page: ScanPage = { id: `p${++seq.current}-${Date.now()}`, original: blob, width: raster.width, height: raster.height, corners, look, previewUrl: URL.createObjectURL(rendered.blob) }
    setPages(prev => {
      const at = insertAt.current
      if (at !== null && at >= 0 && at <= prev.length) { const next = prev.slice(); next.splice(at, 0, page); return next }
      return [...prev, page]
    })
    insertAt.current = null
    setCurrentId(page.id)
    setReturnTo('camera')
    setScreen('adjust')
  }, [])

  const onCapture = useCallback((raster: Raster, blob: Blob, hint: Quad | null) => {
    setWorking(true)
    void addPage(raster, blob, hint)
      .catch(e => toast.error(e instanceof Error && e.message ? e.message : t('Could not use this picture. Please try again.')))
      .finally(() => setWorking(false))
  }, [addPage, t])

  const onPickFiles = useCallback(async (files: File[]) => {
    setWorking(true)
    try {
      let added = 0
      for (const file of files) {
        if (!canAddPage(pagesRef.current.length + added)) { toast.error(t('{n} pages is the most in one scan.', { n: MAX_SCAN_PAGES })); break }
        const decoded = await decodePicture(file, 2400)
        const blob = await rasterToJpegBlob(decoded.raster, 0.9)
        await addPage(decoded.raster, blob, null)
        added++
      }
      if (added > 1) setScreen('pages')
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('This picture could not be read.'))
    } finally {
      setWorking(false)
    }
  }, [addPage, t])

  const onAdjustChange = useCallback((next: { corners: Quad; look: ScanLook; preview: Blob }) => {
    const id = currentId
    if (!id) return
    const old = pagesRef.current.find(p => p.id === id)
    const url = URL.createObjectURL(next.preview)
    lookRef.current = next.look
    setPages(prev => prev.map(p => (p.id === id ? { ...p, corners: next.corners, look: next.look, previewUrl: url } : p)))
    if (old) URL.revokeObjectURL(old.previewUrl)
  }, [currentId])

  const retake = useCallback(() => {
    const id = currentId
    const list = pagesRef.current
    const at = list.findIndex(p => p.id === id)
    if (at >= 0) { URL.revokeObjectURL(list[at].previewUrl); setPages(removePage(list, at)); insertAt.current = at }
    setCurrentId(null)
    setScreen('camera')
  }, [currentId])

  const usePage = useCallback(() => { insertAt.current = null; setScreen(returnTo) }, [returnTo])

  const removeById = useCallback((id: string) => {
    const list = pagesRef.current
    const at = list.findIndex(p => p.id === id)
    if (at < 0) return
    URL.revokeObjectURL(list[at].previewUrl)
    const next = removePage(list, at)
    setPages(next)
    if (next.length === 0) { insertAt.current = null; setScreen('camera') }
  }, [])

  const attach = useCallback(async () => {
    const list = pagesRef.current
    if (list.length === 0 || building) return
    setBuilding(true); setProgress(0)
    try {
      const inputs: PdfPageInput[] = []
      for (let i = 0; i < list.length; i++) {
        setProgress(i + 1)
        await nextFrame()
        const p = list[i]
        const decoded = await decodePicture(p.original, 2400)
        const out = await renderPage(decoded.raster, p.corners, p.look, 2000, 0.85)
        inputs.push({ jpeg: new Uint8Array(await out.blob.arrayBuffer()), width: out.width, height: out.height })
      }
      const bytes = await buildPdf(inputs)
      const file = new File([new Blob([bytes as BlobPart])], scanFileName(cleanScanName(name, defaultName)), { type: 'application/pdf' })
      onDone(file)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('Could not make the PDF. Please try again.'))
    } finally {
      setBuilding(false)
    }
  }, [building, name, defaultName, onDone, t])

  if (!mounted) return null
  const last = pages.length > 0 ? pages[pages.length - 1] : null

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black" role="dialog" aria-modal="true" aria-label={t('Scan document')} data-testid="scan-overlay">
      {screen === 'camera' && (
        <ScanCamera
          pageCount={pages.length} lastPreviewUrl={last?.previewUrl ?? null} atLimit={!canAddPage(pages.length)} maxPages={MAX_SCAN_PAGES}
          onCapture={onCapture} onPickFiles={files => void onPickFiles(files)} onDone={() => setScreen('pages')} onClose={requestClose}
        />
      )}
      {screen === 'adjust' && current && (
        <ScanAdjust page={current} pageNumber={pages.findIndex(p => p.id === current.id) + 1} onChange={onAdjustChange} onRetake={retake} onUse={usePage} />
      )}
      {screen === 'pages' && (
        <ScanPages
          pages={pages} name={name} onName={setName} building={building} progress={progress} atLimit={!canAddPage(pages.length)}
          onOpen={id => { setCurrentId(id); setReturnTo('pages'); setScreen('adjust') }}
          onRemove={removeById} onMove={(from, to) => setPages(prev => movePage(prev, from, to))}
          onAdd={() => { insertAt.current = null; setScreen('camera') }} onBack={() => setScreen('camera')} onAttach={() => void attach()}
        />
      )}

      {working && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40" data-testid="scan-working">
          <span className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium text-white"><Loader2 className="h-4 w-4 animate-spin" />{t('Straightening the page…')}</span>
        </div>
      )}

      {confirmClose && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 px-6" data-testid="scan-confirm-close">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-zinc-900">
            <p className="text-base font-semibold">{pages.length === 1 ? t('Throw away this page?') : t('Throw away {n} pages?', { n: pages.length })}</p>
            <p className="mt-1 text-sm text-zinc-600">{t('Nothing has been attached yet.')}</p>
            <div className="mt-4 flex gap-2.5">
              <button type="button" onClick={() => setConfirmClose(false)} data-testid="scan-keep" className="flex-1 rounded-xl bg-zinc-100 py-2.5 text-sm font-semibold">{t('Keep scanning')}</button>
              <button type="button" onClick={onClose} data-testid="scan-discard" className="flex-1 rounded-xl bg-[#BE1E2D] py-2.5 text-sm font-semibold text-white">{t('Throw away')}</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
