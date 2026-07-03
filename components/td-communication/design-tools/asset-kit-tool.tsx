'use client'

import { useState } from 'react'
import JSZip from 'jszip'
import { Download, Save, Loader2, Package } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  SOCIAL_PRESETS,
  FAVICON_SIZES,
  backgroundHex,
  backgroundLabel,
  resolveBackgrounds,
  socialFileName,
  faviconFileName,
  FAVICON_SVG_PATH,
  buildManifest,
  countKitFiles,
  kitSlug,
  type KitBackground,
} from '@/lib/td-communication/asset-kit'
import { LogoPicker } from './logo-picker'
import {
  loadImage,
  renderLogoCanvas,
  canvasToPngBlob,
  saveDesignAsset,
  downloadBlob,
  type LoadedLogo,
} from './logo-utils'

const ALL_BACKGROUNDS: KitBackground[] = ['transparent', 'white', 'dark']

/** Build the kit zip in-browser. Returns the zip blob. */
async function buildKit(
  logo: LoadedLogo,
  backgrounds: KitBackground[],
): Promise<{ blob: Blob; fileCount: number }> {
  const img = await loadImage(logo.dataUrl)
  const brand = kitSlug(logo.name)
  const zip = new JSZip()

  // Social sizes × backgrounds
  for (const preset of SOCIAL_PRESETS) {
    for (const bg of backgrounds) {
      const canvas = renderLogoCanvas(img, preset.width, preset.height, backgroundHex(bg))
      const png = await canvasToPngBlob(canvas)
      zip.file(socialFileName(preset, bg, brand), png)
    }
  }

  // Favicons — transparent when the source has alpha, else white.
  const faviconBg = logo.hasAlpha ? null : '#ffffff'
  for (const size of FAVICON_SIZES) {
    const canvas = renderLogoCanvas(img, size, size, faviconBg, 0.08)
    zip.file(faviconFileName(size, brand), await canvasToPngBlob(canvas))
  }
  const includeSvgFavicon = logo.dataUrl.startsWith('data:image/svg')
  if (includeSvgFavicon) {
    // Decode the source SVG data URL back to text for a scalable favicon.
    const svgText = await (await fetch(logo.dataUrl)).text()
    zip.file(FAVICON_SVG_PATH(brand), svgText)
  }

  zip.file(
    'README.txt',
    buildManifest({
      brandName: logo.name,
      generatedAtLabel: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      presets: [...SOCIAL_PRESETS],
      backgrounds,
      faviconSizes: [...FAVICON_SIZES],
      includeSvgFavicon,
    }),
  )

  const blob = await zip.generateAsync({ type: 'blob' })
  const fileCount = countKitFiles([...SOCIAL_PRESETS], backgrounds, [...FAVICON_SIZES], includeSvgFavicon)
  return { blob, fileCount }
}

export function AssetKitTool({
  enrollmentId,
  onSaved,
}: {
  /** null = scratchpad: Download only, Save disabled. */
  enrollmentId: string | null
  onSaved?: () => void
}) {
  const [logo, setLogo] = useState<LoadedLogo | null>(null)
  const [selected, setSelected] = useState<KitBackground[]>(['transparent', 'white', 'dark'])
  const [busy, setBusy] = useState<null | 'download' | 'save'>(null)

  const backgrounds = logo ? resolveBackgrounds(selected, logo.hasAlpha) : selected
  const fileCount = logo
    ? countKitFiles(
        [...SOCIAL_PRESETS],
        backgrounds,
        [...FAVICON_SIZES],
        logo.dataUrl.startsWith('data:image/svg'),
      )
    : 0

  function toggleBg(bg: KitBackground) {
    setSelected((cur) => (cur.includes(bg) ? cur.filter((b) => b !== bg) : [...cur, bg]))
  }

  async function run(mode: 'download' | 'save') {
    if (!logo) return
    if (mode === 'save' && !enrollmentId) return
    setBusy(mode)
    try {
      const { blob } = await buildKit(logo, backgrounds)
      const fileName = `${kitSlug(logo.name)}-brand-kit.zip`
      if (mode === 'download' || !enrollmentId) {
        downloadBlob(blob, fileName)
        toast.success('Brand kit downloaded')
      } else {
        await saveDesignAsset(enrollmentId, 'asset_kit', blob, fileName)
        toast.success('Brand kit saved to Deliverables')
        onSaved?.()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the kit.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <LogoPicker enrollmentId={enrollmentId} onLogo={setLogo} loadedName={logo?.name} />

      {/* Background choices */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Backgrounds</span>
        {ALL_BACKGROUNDS.map((bg) => {
          const disabled = bg === 'transparent' && !!logo && !logo.hasAlpha
          const on = selected.includes(bg) && !disabled
          return (
            <button
              key={bg}
              disabled={disabled}
              onClick={() => toggleBg(bg)}
              title={disabled ? 'Source logo has no transparency' : undefined}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-md border',
                disabled
                  ? 'bg-zinc-50 text-zinc-300 border-zinc-100 cursor-not-allowed'
                  : on
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
              )}
            >
              {backgroundLabel(bg)}
              {disabled ? ' (n/a)' : ''}
            </button>
          )
        })}
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs text-zinc-600">
        <p className="font-medium text-zinc-700 inline-flex items-center gap-1">
          <Package className="h-3.5 w-3.5" /> The kit will contain {logo ? fileCount : '—'} files
        </p>
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-zinc-500">
          <li>• {SOCIAL_PRESETS.length} social sizes × {backgrounds.length} background(s)</li>
          <li>• {FAVICON_SIZES.map((s) => `${s}²`).join(', ')} favicons{logo?.dataUrl.startsWith('data:image/svg') ? ' + SVG' : ''}</li>
          {logo && !logo.hasAlpha && (
            <li className="text-amber-600">• Transparent variant unavailable — source logo has no transparency.</li>
          )}
        </ul>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => run('download')}
          disabled={!logo || busy !== null || backgrounds.length === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Download ZIP
        </button>
        <button
          onClick={() => run('save')}
          disabled={!logo || busy !== null || backgrounds.length === 0 || !enrollmentId}
          title={!enrollmentId ? 'Select a project to save into its Deliverables' : undefined}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save to Deliverables
        </button>
      </div>
    </div>
  )
}
