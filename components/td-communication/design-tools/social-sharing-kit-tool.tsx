'use client'

import { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { Download, Send, Loader2, Package, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import type { NamedColor } from '@/lib/td-communication/color-tools'
import {
  SOCIAL_PRESETS,
  FAVICON_SIZES,
  backgroundHex,
  resolveBackgrounds,
  socialFileName,
  faviconFileName,
  FAVICON_SVG_PATH,
  buildManifest,
  kitSlug,
} from '@/lib/td-communication/asset-kit'
import {
  POST_TEMPLATES,
  POST_FORMATS,
  renderPostSvg,
  postFileName,
  socialKitZipName,
  getPostTemplate,
  type PostTemplateId,
} from '@/lib/td-communication/social-kit'
import { LogoPicker } from './logo-picker'
import {
  loadImage,
  renderLogoCanvas,
  canvasToPngBlob,
  svgToPngBlob,
  downloadBlob,
  type LoadedLogo,
} from './logo-utils'

const KIT_BACKGROUNDS = ['transparent', 'white', 'dark'] as const

interface BuildOptions {
  palette: string[]
  templates: PostTemplateId[]
  formats: string[]
  headline: string
  subtext: string
}

/** Build the full social sharing kit zip in-browser (logo assets + branded posts). */
async function buildSocialKit(
  logo: LoadedLogo,
  opts: BuildOptions,
): Promise<{ blob: Blob; fileCount: number }> {
  const img = await loadImage(logo.dataUrl)
  const brand = kitSlug(logo.name)
  const backgrounds = resolveBackgrounds([...KIT_BACKGROUNDS], logo.hasAlpha)
  const zip = new JSZip()
  let fileCount = 0

  // 1. Logo-on-background social sizes (Phase 12 registry).
  for (const preset of SOCIAL_PRESETS) {
    for (const bg of backgrounds) {
      const canvas = renderLogoCanvas(img, preset.width, preset.height, backgroundHex(bg))
      zip.file(socialFileName(preset, bg, brand), await canvasToPngBlob(canvas))
      fileCount++
    }
  }

  // 2. Favicons.
  const faviconBg = logo.hasAlpha ? null : '#ffffff'
  for (const size of FAVICON_SIZES) {
    const canvas = renderLogoCanvas(img, size, size, faviconBg, 0.08)
    zip.file(faviconFileName(size, brand), await canvasToPngBlob(canvas))
    fileCount++
  }
  const includeSvgFavicon = logo.dataUrl.startsWith('data:image/svg')
  if (includeSvgFavicon) {
    const svgText = await (await fetch(logo.dataUrl)).text()
    zip.file(FAVICON_SVG_PATH(brand), svgText)
    fileCount++
  }

  // 3. Branded posts (Phase 15 — the net-new bit): each selected template × format.
  for (const templateId of opts.templates) {
    for (const formatId of opts.formats) {
      const fmt = POST_FORMATS.find((f) => f.id === formatId)
      if (!fmt) continue
      const svg = renderPostSvg(templateId, formatId, {
        palette: opts.palette,
        logoHref: logo.dataUrl,
        headline: opts.headline,
        subtext: opts.subtext,
      })
      if (!svg) continue
      const png = await svgToPngBlob(svg, fmt.width, fmt.height)
      zip.file(postFileName(templateId, formatId, logo.name), png)
      fileCount++
    }
  }

  // 4. Manifest.
  zip.file(
    'README.txt',
    `${buildManifest({
      brandName: logo.name,
      generatedAtLabel: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      presets: [...SOCIAL_PRESETS],
      backgrounds,
      faviconSizes: [...FAVICON_SIZES],
      includeSvgFavicon,
    })}\n\nBRANDED POSTS\n${opts.templates
      .map((t) => `- ${getPostTemplate(t)?.label ?? t}  →  posts/`)
      .join('\n')}\n- Formats: ${opts.formats.join(', ')}`,
  )

  return { blob: await zip.generateAsync({ type: 'blob' }), fileCount }
}

/** Upload a kit zip and record it as a RELEASED, client-facing deliverable. */
async function sendKitToClient(enrollmentId: string, blob: Blob, fileName: string): Promise<void> {
  const urlRes = await fetch(`/api/td-communication/projects/${enrollmentId}/social-kit/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName }),
  })
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, path } = await urlRes.json()
  if (!signedUrl || !path) throw new Error('Could not start the upload. Please try again.')

  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/zip' },
    body: blob,
  })
  if (!put.ok) throw new Error('Upload failed. Please try again.')

  const recRes = await fetch(`/api/td-communication/projects/${enrollmentId}/social-kit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_url: path,
      file_name: fileName,
      file_size: blob.size,
      mime_type: blob.type || 'application/zip',
    }),
  })
  if (!recRes.ok) {
    const d = await recRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not send the kit to the client.')
  }
}

export function SocialSharingKitTool({
  enrollmentId,
  paletteColors,
  onSaved,
}: {
  /** null = scratchpad: Download only, send disabled. */
  enrollmentId: string | null
  paletteColors: NamedColor[]
  onSaved?: () => void
}) {
  const [logo, setLogo] = useState<LoadedLogo | null>(null)
  const [templates, setTemplates] = useState<PostTemplateId[]>(POST_TEMPLATES.map((t) => t.id))
  const [formats, setFormats] = useState<string[]>(['post'])
  const [headline, setHeadline] = useState('')
  const [subtext, setSubtext] = useState('')
  const [manualColor, setManualColor] = useState('#4f6bed')
  const [busy, setBusy] = useState<null | 'download' | 'send'>(null)
  const [alreadySent, setAlreadySent] = useState(false)

  const paletteHex = useMemo(() => {
    const fromProfile = paletteColors.map((c) => c.hex).filter(Boolean)
    return fromProfile.length > 0 ? fromProfile : [manualColor]
  }, [paletteColors, manualColor])

  // Live preview of the first selected template × format.
  const previewTemplate = templates[0]
  const previewFormat = formats[0] ?? 'post'
  const previewSvg = useMemo(() => {
    if (!previewTemplate) return ''
    return renderPostSvg(previewTemplate, previewFormat, {
      palette: paletteHex,
      logoHref: logo?.dataUrl ?? null,
      headline,
      subtext,
    })
  }, [previewTemplate, previewFormat, paletteHex, logo, headline, subtext])

  // Whether a kit was already released for this project (shows a "sent" hint).
  useEffect(() => {
    let cancelled = false
    if (!enrollmentId) {
      setAlreadySent(false)
      return
    }
    fetch(`/api/td-communication/projects/${enrollmentId}/social-kit`)
      .then((r) => (r.ok ? r.json() : { kits: [] }))
      .then((d) => {
        if (!cancelled) setAlreadySent(Array.isArray(d.kits) && d.kits.length > 0)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enrollmentId])

  function toggleTemplate(id: PostTemplateId) {
    setTemplates((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]))
  }
  function toggleFormat(id: string) {
    setFormats((cur) => (cur.includes(id) ? cur.filter((f) => f !== id) : [...cur, id]))
  }

  async function run(mode: 'download' | 'send') {
    if (!logo) return
    if (mode === 'send' && !enrollmentId) return
    if (formats.length === 0) {
      toast.error('Pick at least one format (Feed post or Story).')
      return
    }
    setBusy(mode)
    try {
      const { blob } = await buildSocialKit(logo, {
        palette: paletteHex,
        templates,
        formats,
        headline,
        subtext,
      })
      const fileName = socialKitZipName(logo.name)
      if (mode === 'download' || !enrollmentId) {
        downloadBlob(blob, fileName)
        toast.success('Social sharing kit downloaded')
      } else {
        await sendKitToClient(enrollmentId, blob, fileName)
        setAlreadySent(true)
        toast.success('Social sharing kit sent to the client')
        onSaved?.()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the kit.')
    } finally {
      setBusy(null)
    }
  }

  const usingProfilePalette = paletteColors.length > 0
  const usesSubtext = previewTemplate ? !!getPostTemplate(previewTemplate)?.usesSubtext : true

  return (
    <div className="space-y-3">
      {/* Plain-English "How it works" — same collapsed <details> convention as the
          Design Tools section read-me. Explains this tab specifically. */}
      <details className="rounded-xl border border-zinc-200 bg-white text-sm text-zinc-700">
        <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-800">
          How the Social Sharing Kit works — read me
        </summary>
        <div className="space-y-4 border-t border-zinc-100 px-3 py-3 leading-relaxed text-[13px]">
          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">What it is</h3>
            <p>
              The client-facing bundle. From one logo and the brand colours it builds the platform-sized
              logo assets (profile pictures, Instagram post/story, X header, FB/LinkedIn cover, favicons){' '}
              <em>plus</em> ready-to-post <strong>branded templates</strong> (announcement, tagline, launch)
              with your own headline — all zipped together for the client to download.
            </p>
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">How to use it</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Add the final logo — drag a file in, or pick one already in the project&apos;s Deliverables.</li>
              <li>
                Brand colours come from the <strong>AI Brand Profile</strong> automatically; if there&apos;s
                no profile yet, pick a base colour.
              </li>
              <li>
                Choose which post templates and formats (feed / story) to include, and type an optional
                headline / subtext — the live preview updates as you go.
              </li>
              <li>
                <strong>Download ZIP</strong> to grab it yourself, or <strong>Generate &amp; send to
                client</strong> to make it downloadable from their portal.
              </li>
            </ul>
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold text-amber-700">Good to know</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>The client only sees the kit once the project is delivered</strong> AND the Social
                Sharing Kit is switched on in <strong>Settings</strong>. Until then, nothing is visible to
                them.
              </li>
              <li>
                <strong>Sending never changes the project.</strong> It doesn&apos;t move the status or touch
                the client&apos;s logo reveal — the kit is a separate, post-delivery download.
              </li>
              <li>
                <strong>Sending again adds a newer version</strong> — the client always gets the latest one.
              </li>
              <li>
                <strong>Transparent variants</strong> only appear when the uploaded logo actually has
                transparency (a flat JPG has none).
              </li>
            </ul>
          </section>
        </div>
      </details>

      <LogoPicker enrollmentId={enrollmentId} onLogo={setLogo} loadedName={logo?.name} />

      {/* Brand colour source */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-zinc-500">Brand colours</span>
        {usingProfilePalette ? (
          <div className="flex items-center gap-1">
            {paletteColors.slice(0, 6).map((c) => (
              <span
                key={c.hex}
                className="h-4 w-4 rounded border border-zinc-200"
                style={{ backgroundColor: c.hex }}
                title={`${c.name} ${c.hex}`}
              />
            ))}
            <span className="text-[11px] text-zinc-400">from AI Brand Profile</span>
          </div>
        ) : (
          <label className="flex items-center gap-1">
            <input
              type="color"
              value={manualColor}
              onChange={(e) => setManualColor(e.target.value)}
              className="h-6 w-8 cursor-pointer rounded border border-zinc-200 bg-white p-0"
            />
            <span className="text-[11px] text-zinc-400">no profile yet — pick a base colour</span>
          </label>
        )}
      </div>

      {/* Branded post templates */}
      <div className="space-y-1.5">
        <span className="text-xs text-zinc-500">Branded posts</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {POST_TEMPLATES.map((t) => {
            const on = templates.includes(t.id)
            return (
              <button
                key={t.id}
                onClick={() => toggleTemplate(t.id)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-md border',
                  on
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {POST_FORMATS.map((f) => {
            const on = formats.includes(f.id)
            return (
              <button
                key={f.id}
                onClick={() => toggleFormat(f.id)}
                className={cn(
                  'px-2 py-0.5 text-[11px] font-medium rounded border',
                  on
                    ? 'bg-zinc-800 text-white border-zinc-800'
                    : 'bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-50',
                )}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Post text */}
      <div className="grid grid-cols-1 gap-1.5">
        <input
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          maxLength={60}
          placeholder={previewTemplate ? getPostTemplate(previewTemplate)?.defaultHeadline : 'Headline'}
          className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs"
        />
        {usesSubtext && (
          <input
            value={subtext}
            onChange={(e) => setSubtext(e.target.value)}
            maxLength={90}
            placeholder="Optional subtext"
            className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs"
          />
        )}
      </div>

      {/* Live preview */}
      {previewSvg && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          <div
            className="mx-auto max-w-[220px] overflow-hidden rounded border border-zinc-200 [&_svg]:h-auto [&_svg]:w-full"
            // SVG is generated from escaped text/attrs (no injection) — safe to inline.
            // The [&_svg] utilities force the 1080px art to scale to the preview box.
            dangerouslySetInnerHTML={{ __html: previewSvg }}
          />
          <p className="mt-1.5 text-center text-[11px] text-zinc-400">
            Preview — {getPostTemplate(previewTemplate!)?.label} · {previewFormat}
          </p>
        </div>
      )}

      {/* Summary */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs text-zinc-600">
        <p className="font-medium text-zinc-700 inline-flex items-center gap-1">
          <Package className="h-3.5 w-3.5" /> The kit includes logo assets, favicons, and{' '}
          {templates.length * formats.length} branded post{templates.length * formats.length === 1 ? '' : 's'}
        </p>
        {alreadySent && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-green-600">
            <CheckCircle2 className="h-3 w-3" /> A kit has been sent to this client — sending again adds a newer version.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => run('download')}
          disabled={!logo || busy !== null}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Download ZIP
        </button>
        <FastTooltip label={!enrollmentId ? 'Select a project to send the kit to its client' : undefined}>
          <button
            onClick={() => run('send')}
            disabled={!logo || busy !== null || !enrollmentId}
            aria-label={!enrollmentId ? 'Select a project to send the kit to its client' : undefined}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Generate &amp; send to client
          </button>
        </FastTooltip>
      </div>
      <p className="text-[11px] text-zinc-400">
        The client can download the kit from their portal once the project is <strong>delivered</strong> and the
        Social Sharing Kit is switched on in Settings.
      </p>
    </div>
  )
}
