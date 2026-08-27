'use client'

import { useMemo, useState } from 'react'
import { Download, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  MOCKUP_TEMPLATES,
  getMockupTemplate,
  renderMockupSvg,
} from '@/lib/td-communication/mockup-templates'
import { normalizeHex, type NamedColor } from '@/lib/td-communication/color-tools'
import type { LogoGeometry } from '@/lib/td-communication/geometry'
import { LogoPicker } from './logo-picker'
import { svgToPngBlob, saveDesignAsset, downloadBlob, type LoadedLogo } from './logo-utils'

export function MockupPreviewer({
  enrollmentId,
  paletteColors,
  geometry,
  onSaved,
}: {
  /** null = scratchpad: preview + Export only, Save disabled. */
  enrollmentId: string | null
  paletteColors: NamedColor[]
  /** The project's chosen logo geometry — themes the container corners when applied. */
  geometry?: LogoGeometry | null
  onSaved?: () => void
}) {
  const [logo, setLogo] = useState<LoadedLogo | null>(null)
  const [templateId, setTemplateId] = useState<string>(MOCKUP_TEMPLATES[0].id)
  const [scale, setScale] = useState(1)
  const template = getMockupTemplate(templateId)!
  const [bg, setBg] = useState<string>(template.recommendedBg)
  const [busy, setBusy] = useState<null | 'export' | 'save'>(null)
  // When a brand geometry exists, follow its corner radius by default (opt-out).
  const [useGeometry, setUseGeometry] = useState(true)
  const cornerRadius = geometry && useGeometry ? geometry.corner_radius : undefined

  const bgSwatches = useMemo(() => {
    const fromPalette = paletteColors.map((c) => normalizeHex(c.hex)).filter((h): h is string => !!h)
    return Array.from(new Set(['#ffffff', '#111111', ...fromPalette]))
  }, [paletteColors])

  const svg = useMemo(
    () => renderMockupSvg(templateId, { bg, logoHref: logo?.dataUrl ?? null, logoScale: scale, cornerRadius }),
    [templateId, bg, logo, scale, cornerRadius],
  )

  async function makeBlob(): Promise<Blob> {
    return svgToPngBlob(svg, template.width, template.height)
  }

  const fileBase = `${logo?.name || 'brand'}-${templateId}`

  async function onExport() {
    if (!logo) return
    setBusy('export')
    try {
      downloadBlob(await makeBlob(), `${fileBase}.png`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  async function onSave() {
    if (!logo || !enrollmentId) return
    setBusy('save')
    try {
      await saveDesignAsset(enrollmentId, 'mockup', await makeBlob(), `${fileBase}.png`)
      toast.success('Mockup saved to Deliverables')
      onSaved?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the mockup.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <LogoPicker enrollmentId={enrollmentId} onLogo={setLogo} loadedName={logo?.name} />

      {/* Template + background controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {MOCKUP_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTemplateId(t.id)
                setBg(t.recommendedBg)
              }}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-md border',
                t.id === templateId
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Background</span>
        {bgSwatches.map((h) => (
          <FastTooltip key={h} label={h}>
            <button
              onClick={() => setBg(h)}
              aria-label={h}
              className={cn(
                'h-6 w-6 rounded border',
                bg === h ? 'ring-2 ring-blue-400 border-blue-400' : 'border-zinc-200',
              )}
              style={{ backgroundColor: h }}
            />
          </FastTooltip>
        ))}
        <input
          type="color"
          value={normalizeHex(bg) ?? '#ffffff'}
          onChange={(e) => setBg(e.target.value)}
          className="h-6 w-8 rounded border border-zinc-200 bg-white p-0.5"
          aria-label="Custom background colour"
        />
        <span className="text-xs text-zinc-500 ml-2">Logo size</span>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.05}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
          className="w-28"
        />
        {geometry && (
          <label className="text-xs text-zinc-500 inline-flex items-center gap-1 ml-2" title="Round the card / website-frame corners to match the brand geometry chosen in the Geometry tab">
            <input type="checkbox" checked={useGeometry} onChange={(e) => setUseGeometry(e.target.checked)} />
            Match brand geometry
          </label>
        )}
      </div>

      {/* Preview */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-100 p-3 flex items-center justify-center">
        {logo ? (
          <div
            className="w-full max-w-md [&>svg]:w-full [&>svg]:h-auto [&>svg]:rounded [&>svg]:shadow-sm"
            // The SVG is generated from a validated template + hex + the partner's
            // own data-URL logo (href-escaped in escapeXmlAttr). Staff/partner only.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <p className="text-sm text-zinc-400 py-8">Add a logo to preview it on brand touchpoints.</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onExport}
          disabled={!logo || busy !== null}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export PNG
        </button>
        <FastTooltip label={!enrollmentId ? 'Select a project to save into its Deliverables' : undefined}>
          <button
            onClick={onSave}
            disabled={!logo || busy !== null || !enrollmentId}
            aria-label={!enrollmentId ? 'Select a project to save into its Deliverables' : undefined}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save to Deliverables
          </button>
        </FastTooltip>
      </div>
    </div>
  )
}
