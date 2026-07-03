'use client'

import { useMemo, useState } from 'react'
import { Palette } from 'lucide-react'
import type { CommEnrollment } from '@/lib/td-communication/types'
import type { NamedColor } from '@/lib/td-communication/color-tools'
import { DesignToolsSection } from './design-tools-section'

/**
 * Standalone Design Tools workspace — the tools surfaced at the dashboard level
 * (a top-level tab on the CRM + /collab) instead of only inside a project's brief
 * panel. A project picker at the top loads that project's brand palette and
 * targets its Deliverables for Save; with no project selected it is a scratchpad
 * (Palette from a base colour, Mockups/Asset Kit export-only).
 *
 * Reads the palette from the board row's cached metadata.ai_brand_profile — no
 * extra fetch. Reuses DesignToolsSection (read-me + the three tools) verbatim.
 */

function subjectName(p: CommEnrollment): string {
  return p.subject?.name || 'Untitled project'
}

/** Pull a valid {hex,name}[] palette out of a board row's cached AI brand profile. */
export function paletteFor(p: CommEnrollment | undefined): NamedColor[] {
  if (!p) return []
  const profile = (p.metadata as Record<string, unknown> | undefined)?.['ai_brand_profile'] as
    | { color_palette?: unknown }
    | undefined
  const arr = Array.isArray(profile?.color_palette) ? (profile!.color_palette as unknown[]) : []
  return arr
    .map((c) => {
      const o = c as { hex?: unknown; name?: unknown }
      return typeof o?.hex === 'string'
        ? { hex: o.hex, name: typeof o.name === 'string' ? o.name : '' }
        : null
    })
    .filter((c): c is NamedColor => c !== null)
}

export function DesignToolsWorkspace({ projects }: { projects: CommEnrollment[] }) {
  const selectable = useMemo(() => projects.filter((p) => p.status !== 'cancelled'), [projects])

  // Default to a project that already has a brand profile (so the palette is
  // populated on open), else the first project, else scratchpad.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const withProfile = selectable.find((p) => paletteFor(p).length > 0)
    return withProfile?.id ?? selectable[0]?.id ?? null
  })

  const selected = selectable.find((p) => p.id === selectedId)
  const paletteColors = paletteFor(selected)

  return (
    <div className="max-w-3xl mx-auto p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 inline-flex items-center gap-2">
          <Palette className="h-5 w-5" /> Design Tools
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Palette, mockups and a brand asset kit — use them here without opening a project. Pick a client
          to load its brand colours and save results into its Deliverables, or work in scratch mode
          (export only).
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-zinc-500">Project</label>
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value || null)}
          className="text-sm border border-zinc-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200 min-w-[16rem]"
        >
          <option value="">Scratchpad (no project — export only)</option>
          {selectable.map((p) => (
            <option key={p.id} value={p.id}>
              {subjectName(p)}
            </option>
          ))}
        </select>
        {selected && paletteColors.length === 0 && (
          <span className="text-xs text-amber-600">
            No brand profile yet — generate it inside the project to load its colours.
          </span>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        {/* key resets tool state cleanly when switching project/scratchpad. */}
        <DesignToolsSection key={selectedId ?? 'scratch'} enrollmentId={selectedId} paletteColors={paletteColors} />
      </div>
    </div>
  )
}
