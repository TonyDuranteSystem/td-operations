'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useTalkI18n } from '@/components/talk/talk-i18n'
import { detectPage, toSmallGray } from '@/lib/scan/detect-page'
import { scaleQuad, type Quad, type Raster } from '@/lib/scan/geometry'
import { createSteadyTracker } from '@/lib/scan/steady'
import { grabVideoFrame, makeSmallLooker, openBackCamera, type CameraProblem } from '@/lib/scan/browser'

/** The camera screen: live picture, a green outline on the page it finds, and a picture taken by itself when the outline holds still. */
export function ScanCamera({ pageCount, lastPreviewUrl, atLimit, maxPages, onCapture, onPickFiles, onDone, onClose }: {
  pageCount: number
  lastPreviewUrl: string | null
  atLimit: boolean
  maxPages: number
  /** `corners` = where the page was found in the picture (null when it was not found). */
  onCapture: (raster: Raster, blob: Blob, corners: Quad | null) => void
  /** No camera (or no permission): pictures chosen or taken through the phone's own picker. */
  onPickFiles: (files: File[]) => void
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useTalkI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<CameraProblem | null>(null)
  const [ready, setReady] = useState(false)
  const [auto, setAuto] = useState(true)
  const [found, setFound] = useState<{ quad: Quad; vw: number; vh: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [flash, setFlash] = useState(false)
  const lastQuad = useRef<Quad | null>(null)
  const tracker = useRef(createSteadyTracker())
  const capturing = useRef(false)
  const autoRef = useRef(auto); autoRef.current = auto
  const limitRef = useRef(atLimit); limitRef.current = atLimit
  const onCaptureRef = useRef(onCapture); onCaptureRef.current = onCapture
  const takePhotoRef = useRef<HTMLInputElement>(null)
  const choosePhotoRef = useRef<HTMLInputElement>(null)

  // open the back camera; close it again when this screen goes away
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    openBackCamera().then(s => {
      if (cancelled) { s.getTracks().forEach(tr => tr.stop()); return }
      stream = s
      const v = videoRef.current
      if (v) { v.srcObject = s; void v.play().catch(() => {}) }
    }).catch((p: CameraProblem) => { if (!cancelled) setProblem(p) })
    return () => { cancelled = true; stream?.getTracks().forEach(tr => tr.stop()) }
  }, [])

  const capture = useCallback(async () => {
    const v = videoRef.current
    if (!v || capturing.current || limitRef.current || !v.videoWidth) return
    capturing.current = true
    try {
      const hint = lastQuad.current
      const frame = await grabVideoFrame(v, 2400)
      setFlash(true); setTimeout(() => setFlash(false), 140)
      const corners = hint ? scaleQuad(hint, frame.raster.width / v.videoWidth, frame.raster.height / v.videoHeight) : null
      tracker.current.reset(); setProgress(0); setFound(null); lastQuad.current = null
      onCaptureRef.current(frame.raster, frame.blob, corners)
    } finally {
      capturing.current = false
    }
  }, [])

  // look for the page a few times a second
  useEffect(() => {
    if (!ready || problem) return
    const look = makeSmallLooker(160)
    const timer = setInterval(() => {
      const v = videoRef.current
      if (!v || capturing.current || v.paused || v.ended) return
      const small = look(v)
      if (!small) return
      const { gray } = toSmallGray(small, 160)
      const f = detectPage(gray)
      const vw = v.videoWidth, vh = v.videoHeight
      const quad = f ? scaleQuad(f.quad, vw / small.width, vh / small.height) : null
      lastQuad.current = quad
      setFound(quad ? { quad, vw, vh } : null)
      const st = tracker.current.push(quad, vw, vh)
      setProgress(autoRef.current ? st.progress : 0)
      if (st.steady && autoRef.current && !limitRef.current) void capture()
    }, 160)
    return () => clearInterval(timer)
  }, [ready, problem, capture])

  const pick = (list: FileList | null) => {
    if (list && list.length) onPickFiles(Array.from(list))
    if (takePhotoRef.current) takePhotoRef.current.value = ''
    if (choosePhotoRef.current) choosePhotoRef.current.value = ''
  }

  const RING = 2 * Math.PI * 30
  const hint = atLimit
    ? t('{n} pages is the most in one scan.', { n: maxPages })
    : found ? (auto ? t('Page found. Hold steady') : t('Page found')) : t('Looking for the page…')

  return (
    <div className="flex h-full flex-col bg-black text-white" data-testid="scan-camera">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef} playsInline muted autoPlay
          onLoadedMetadata={() => setReady(true)}
          className="absolute inset-0 h-full w-full object-contain" data-testid="scan-video"
        />
        {found && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${found.vw} ${found.vh}`} preserveAspectRatio="xMidYMid meet" data-testid="scan-outline" aria-hidden="true">
            <polygon points={found.quad.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(34,197,94,0.12)" stroke="#22c55e" strokeWidth={Math.max(3, found.vw / 280)} strokeLinejoin="round" />
            {found.quad.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(5, found.vw / 190)} fill="#22c55e" />)}
          </svg>
        )}
        {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}

        <div className="absolute left-3 right-3 top-3 flex items-center justify-between" style={{ marginTop: 'env(safe-area-inset-top, 0px)' }}>
          <button type="button" onClick={onClose} aria-label={t('Close the scanner')} data-testid="scan-close" className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 active:bg-black/80">
            <X className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => { setAuto(a => !a); tracker.current.reset(); setProgress(0) }} aria-pressed={auto} data-testid="scan-auto" className="rounded-full bg-black/55 px-3 py-1.5 text-xs font-semibold active:bg-black/80">
            {auto ? t('Auto: on') : t('Auto: off')}
          </button>
        </div>

        {!problem && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold" data-testid="scan-hint">{hint}</div>
        )}

        {problem && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 px-8 text-center" data-testid="scan-camera-problem">
            <p className="text-base font-semibold">
              {problem === 'denied' ? t('The camera is switched off for this app.') : t('The camera is not available here.')}
            </p>
            <p className="max-w-xs text-sm text-white/70">
              {problem === 'denied'
                ? t('Allow the camera in your phone settings, or take a photo of the page instead.')
                : t('You can still scan: take a photo of the page, or choose one you already have.')}
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={() => takePhotoRef.current?.click()} disabled={atLimit} data-testid="scan-take-photo" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-40">{t('Take a photo')}</button>
              <button type="button" onClick={() => choosePhotoRef.current?.click()} disabled={atLimit} data-testid="scan-choose-photo" className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold disabled:opacity-40">{t('Choose a photo')}</button>
            </div>
          </div>
        )}
      </div>

      <input ref={takePhotoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => pick(e.target.files)} data-testid="scan-take-photo-input" />
      <input ref={choosePhotoRef} type="file" accept="image/*" multiple className="hidden" onChange={e => pick(e.target.files)} data-testid="scan-choose-photo-input" />

      <div className="flex h-[104px] shrink-0 items-center justify-between bg-[#0b0b0e] px-6" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <button type="button" onClick={onDone} disabled={pageCount === 0} aria-label={t('Look at your pages')} data-testid="scan-thumb" className="relative h-14 w-11 shrink-0 disabled:opacity-30">
          {lastPreviewUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={lastPreviewUrl} alt="" className="h-full w-full rounded object-cover" />
            : <span className="block h-full w-full rounded border border-white/30" />}
          {pageCount > 0 && <span className="absolute -right-2 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#BE1E2D] px-1 text-[10px] font-bold" data-testid="scan-count">{pageCount}</span>}
        </button>

        <button type="button" onClick={() => void capture()} disabled={!ready || !!problem || atLimit} aria-label={t('Take the picture')} data-testid="scan-shutter" className="relative flex h-[68px] w-[68px] items-center justify-center disabled:opacity-40">
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 68 68" aria-hidden="true">
            <circle cx="34" cy="34" r="30" fill="none" stroke="white" strokeWidth="4" opacity={progress > 0 ? 0.35 : 1} />
            {progress > 0 && <circle cx="34" cy="34" r="30" fill="none" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - progress)} data-testid="scan-ring" />}
          </svg>
          <span className="block h-[50px] w-[50px] rounded-full bg-white" />
        </button>

        <button type="button" onClick={onDone} disabled={pageCount === 0} data-testid="scan-done" className="w-11 text-right text-sm font-semibold disabled:opacity-30">{t('Done')}</button>
      </div>
    </div>
  )
}
