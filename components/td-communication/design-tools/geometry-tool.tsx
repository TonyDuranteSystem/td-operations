'use client'

import { useMemo, useState } from 'react'
import { Download, Save, Loader2, Bookmark } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { normalizeHex, type NamedColor } from '@/lib/td-communication/color-tools'
import {
  GEOMETRY_PRESETS,
  geometryFromPreset,
  withGeometryOverride,
  renderGeometrySvg,
  geometryFileName,
  geometrySummary,
  defaultGeometry,
  type LogoGeometry,
  type CornerStyle,
} from '@/lib/td-communication/geometry'
import { svgToPngBlob, saveDesignAsset, downloadBlob } from './logo-utils'

const RENDER_SIZE = 800

/**
 * Geometry tool — helps Cris decide and communicate the logo's shape language
 * (corner treatment), themed on the brand colour. Produces a corner-treatment
 * SPECIMEN (not a finished logo) she can Export (SVG + PNG) and Save to
 * Deliverables, and lets her save the chosen geometry to the brand so a future
 * logo generator (and the Mockups tool) can read it. Everything client-side.
 */
export function GeometryTool({
  enrollmentId,
  paletteColors,
  brandName,
  initialGeometry,
  onSaved,
  onGeometrySaved,
}: {
  /** null = scratchpad: preview + Export only; Save + Save-to-brand disabled. */
  enrollmentId: string | null
  paletteColors: NamedColor[]
  brandName?: string
  initialGeometry?: LogoGeometry | null
  onSaved?: () => void
  onGeometrySaved?: (g: LogoGeometry) => void
}) {
  const [geo, setGeo] = useState<LogoGeometry>(initialGeometry ?? defaultGeometry())
  const [busy, setBusy] = useState<null | 'export-svg' | 'export-png' | 'save' | 'brand'>(null)

  const swatches = useMemo(() => {
    const fromPalette = paletteColors.map((c) => normalizeHex(c.hex)).filter((h): h is string => !!h)
    return Array.from(new Set([...fromPalette, '#1f2937', '#2563eb', '#111111']))
  }, [paletteColors])
  const [bg, setBg] = useState<string>(swatches[0] || '#1f2937')

  const label = `${geometrySummary(geo)}`
  const svg = useMemo(
    () => renderGeometrySvg(geo, { size: RENDER_SIZE, bg, ink: '#111827', label }),
    [geo, bg, label],
  )

  const patch = (p: Partial<Pick<LogoGeometry, 'corner_style' | 'corner_radius' | 'edge_sharpness'>>) =>
    setGeo((g) => withGeometryOverride(g, p))

  function svgBlob(): Blob {
    return new Blob([svg], { type: 'image/svg+xml' })
  }

  async function onExportSvg() {
    setBusy('export-svg')
    try {
      downloadBlob(svgBlob(), geometryFileName(brandName || '', geo, 'svg'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  async function onExportPng() {
    setBusy('export-png')
    try {
      downloadBlob(await svgToPngBlob(svg, RENDER_SIZE, RENDER_SIZE), geometryFileName(brandName || '', geo, 'png'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  async function onSave() {
    if (!enrollmentId) return
    setBusy('save')
    try {
      // Option B: the SVG (the vector asset) is the saved deliverable.
      await saveDesignAsset(enrollmentId, 'geometry', svgBlob(), geometryFileName(brandName || '', geo, 'svg'))
      toast.success('Geometry saved to Deliverables')
      onSaved?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the geometry.')
    } finally {
      setBusy(null)
    }
  }

  async function onSaveToBrand() {
    if (!enrollmentId) return
    setBusy('brand')
    try {
      const res = await fetch(`/api/td-communication/projects/${enrollmentId}/geometry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: geo }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save to the brand.')
      toast.success('Geometry saved to the brand profile')
      onGeometrySaved?.(data.geometry as LogoGeometry)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save to the brand.')
    } finally {
      setBusy(null)
    }
  }

  const STYLES: { id: CornerStyle; label: string }[] = [
    { id: 'round', label: 'Round' },
    { id: 'bevel', label: 'Bevel' },
  ]

  return (
    <div className="space-y-3">
      {/* Presets */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-zinc-500">Preset</span>
        {GEOMETRY_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setGeo(geometryFromPreset(p.id))}
            className={cn(
              'px-2.5 py-1 text-xs font-medium rounded-md border',
              geo.preset_id === p.id && geo.source === 'preset'
                ? 'bg-blue-50 text-blue-700 border-blue-200'
                : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Corner style + sliders */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Corner</span>
        {STYLES.map((s) => (
          <button
            key={s.id}
            onClick={() => patch({ corner_style: s.id })}
            className={cn(
              'px-2.5 py-1 text-xs font-medium rounded-md border',
              geo.corner_style === s.id ? 'bg-zinc-200 text-zinc-800 border-zinc-300' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap text-xs text-zinc-500">
        <label className="flex items-center gap-1">
          Radius
          <input type="range" min={0} max={1} step={0.01} value={geo.corner_radius} onChange={(e) => patch({ corner_radius: Number(e.target.value) })} className="w-28" />
          <span className="tabular-nums w-8">{Math.round(geo.corner_radius * 100)}%</span>
        </label>
        <label className={cn('flex items-center gap-1', geo.corner_style !== 'bevel' && 'opacity-40')}>
          Sharpness
          <input type="range" min={0} max={1} step={0.01} value={geo.edge_sharpness} disabled={geo.corner_style !== 'bevel'} onChange={(e) => patch({ edge_sharpness: Number(e.target.value) })} className="w-28" />
          <span className="tabular-nums w-8">{Math.round(geo.edge_sharpness * 100)}%</span>
        </label>
      </div>

      {/* Brand colour */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Colour</span>
        {swatches.map((h) => (
          <button
            key={h}
            onClick={() => setBg(h)}
            title={h}
            className={cn('h-6 w-6 rounded border', bg === h ? 'ring-2 ring-blue-400 border-blue-400' : 'border-zinc-200')}
            style={{ backgroundColor: h }}
          />
        ))}
        <input type="color" value={normalizeHex(bg) ?? '#1f2937'} onChange={(e) => setBg(e.target.value)} className="h-6 w-8 rounded border border-zinc-200 bg-white p-0.5" aria-label="Custom colour" />
      </div>

      {/* Preview */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-100 p-3 flex items-center justify-center">
        <div
          className="w-full max-w-xs [&>svg]:w-full [&>svg]:h-auto [&>svg]:rounded [&>svg]:shadow-sm"
          // Generated from the pure XML-escaped template (renderGeometrySvg) — no user
          // SVG, staff/partner only. Same pattern as the Mockups previewer.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={onExportSvg} disabled={busy !== null} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
          {busy === 'export-svg' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export SVG
        </button>
        <button onClick={onExportPng} disabled={busy !== null} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
          {busy === 'export-png' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export PNG
        </button>
        <button onClick={onSave} disabled={busy !== null || !enrollmentId} title={!enrollmentId ? 'Select a project to save into its Deliverables' : undefined} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50">
          {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save to Deliverables
        </button>
        <button onClick={onSaveToBrand} disabled={busy !== null || !enrollmentId} title={!enrollmentId ? 'Select a project to save its brand geometry' : 'Save this as the brand’s logo geometry'} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
          {busy === 'brand' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bookmark className="h-3.5 w-3.5" />}
          Save to brand
        </button>
      </div>
    </div>
  )
}
