'use client'

import { useMemo, useState } from 'react'
import { Copy, Check, Download } from 'lucide-react'
import { toast } from 'sonner'
import {
  normalizeHex,
  rgbString,
  contrastRatio,
  wcagRating,
  bestTextColor,
  complementary,
  analogous,
  triadic,
  tints,
  shades,
  formatExports,
  type NamedColor,
} from '@/lib/td-communication/color-tools'

async function copy(text: string, label: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast.success(`Copied ${label}`)
  } catch {
    toast.error('Could not copy — select and copy manually.')
  }
}

function Swatch({ hex, name }: { hex: string; name?: string }) {
  const ink = bestTextColor(hex)
  return (
    <button
      onClick={() => copy(hex, hex)}
      title="Copy hex"
      className="group relative h-16 w-full rounded-lg border border-black/10 flex flex-col justify-end p-1.5 text-left"
      style={{ backgroundColor: hex }}
    >
      <span className="text-[10px] font-mono font-semibold" style={{ color: ink }}>
        {hex}
      </span>
      {name ? (
        <span className="text-[9px] truncate" style={{ color: ink, opacity: 0.85 }}>
          {name}
        </span>
      ) : null}
      <Copy
        className="absolute top-1.5 right-1.5 h-3 w-3 opacity-0 group-hover:opacity-70"
        style={{ color: ink }}
      />
    </button>
  )
}

function Row({ label, colors }: { label: string; colors: string[] }) {
  if (colors.length === 0) return null
  return (
    <div>
      <p className="text-[11px] font-medium text-zinc-500 mb-1">{label}</p>
      <div className="grid grid-cols-5 gap-1.5">
        {colors.map((c, i) => (
          <Swatch key={`${c}-${i}`} hex={c} />
        ))}
      </div>
    </div>
  )
}

function ContrastBadge({ ratio }: { ratio: number }) {
  const r = wcagRating(ratio)
  const pass = r.AA
  return (
    <span
      className={
        'text-[9px] font-semibold px-1 py-0.5 rounded ' +
        (r.AAA
          ? 'bg-emerald-100 text-emerald-700'
          : r.AA
            ? 'bg-blue-100 text-blue-700'
            : r.AALarge
              ? 'bg-amber-100 text-amber-700'
              : 'bg-red-100 text-red-700')
      }
      title={`Contrast ${ratio.toFixed(2)}:1`}
    >
      {ratio.toFixed(1)} {r.AAA ? 'AAA' : r.AA ? 'AA' : r.AALarge ? 'AA Lg' : pass ? '' : 'Fail'}
    </span>
  )
}

const EXPORT_FORMATS = [
  { key: 'css', label: 'CSS variables' },
  { key: 'scss', label: 'SCSS' },
  { key: 'json', label: 'JSON' },
  { key: 'tailwind', label: 'Tailwind' },
  { key: 'list', label: 'Hex list' },
] as const

export function ColorPaletteTool({ initialColors }: { initialColors: NamedColor[] }) {
  const profileColors = useMemo(
    () => initialColors.filter((c) => normalizeHex(c.hex)).map((c) => ({ hex: normalizeHex(c.hex)!, name: c.name })),
    [initialColors],
  )
  const [base, setBase] = useState<string>(profileColors[0]?.hex ?? '#3b82f6')
  const [copiedFmt, setCopiedFmt] = useState<string | null>(null)

  const normBase = normalizeHex(base)
  const exports = useMemo(
    () => formatExports(profileColors.length ? profileColors : normBase ? [{ hex: normBase, name: 'Base' }] : []),
    [profileColors, normBase],
  )

  return (
    <div className="space-y-4">
      {/* Brand palette from the profile */}
      {profileColors.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium text-zinc-500 mb-1">Brand palette (from the AI profile)</p>
          <div className="grid grid-cols-5 gap-1.5">
            {profileColors.map((c, i) => (
              <Swatch key={`${c.hex}-${i}`} hex={c.hex} name={c.name} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-400">
          No AI brand profile yet — generate one above, or pick a base colour to explore palettes.
        </p>
      )}

      {/* Base colour + contrast */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Base</span>
        <input
          type="color"
          value={normBase ?? '#3b82f6'}
          onChange={(e) => setBase(e.target.value)}
          className="h-7 w-9 rounded border border-zinc-200 bg-white p-0.5"
          aria-label="Base colour picker"
        />
        <input
          type="text"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          className="text-xs font-mono border border-zinc-200 rounded-md px-2 py-1 w-24 focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        {normBase && (
          <>
            <span className="text-[11px] text-zinc-400">{rgbString(normBase)}</span>
            <span className="inline-flex items-center gap-1">
              <span className="text-[10px] text-zinc-400">on white</span>
              <ContrastBadge ratio={contrastRatio(normBase, '#ffffff') ?? 1} />
              <span className="text-[10px] text-zinc-400">on black</span>
              <ContrastBadge ratio={contrastRatio(normBase, '#000000') ?? 1} />
            </span>
          </>
        )}
      </div>

      {/* Generated palettes */}
      {normBase && (
        <div className="space-y-3">
          <Row label="Complementary" colors={complementary(normBase)} />
          <Row label="Analogous" colors={analogous(normBase)} />
          <Row label="Triadic" colors={triadic(normBase)} />
          <Row label="Tints" colors={tints(normBase, 5)} />
          <Row label="Shades" colors={shades(normBase, 5)} />
        </div>
      )}

      {/* Exports */}
      <div>
        <p className="text-[11px] font-medium text-zinc-500 mb-1 inline-flex items-center gap-1">
          <Download className="h-3 w-3" /> Export{' '}
          {profileColors.length ? 'brand palette' : 'base colour'}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                copy(exports[f.key], f.label)
                setCopiedFmt(f.key)
                setTimeout(() => setCopiedFmt((c) => (c === f.key ? null : c)), 1500)
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
            >
              {copiedFmt === f.key ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              {f.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
