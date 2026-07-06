'use client'

import { useState } from 'react'
import { Palette, LayoutTemplate, Package, Share2, Shapes } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NamedColor } from '@/lib/td-communication/color-tools'
import type { LogoGeometry } from '@/lib/td-communication/geometry'
import { ColorPaletteTool } from './color-palette-tool'
import { MockupPreviewer } from './mockup-previewer'
import { AssetKitTool } from './asset-kit-tool'
import { SocialSharingKitTool } from './social-sharing-kit-tool'
import { GeometryTool } from './geometry-tool'

type Tab = 'palette' | 'mockups' | 'kit' | 'social' | 'geometry'

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: 'palette', label: 'Palette', icon: Palette },
  { id: 'mockups', label: 'Mockups', icon: LayoutTemplate },
  { id: 'geometry', label: 'Geometry', icon: Shapes },
  { id: 'kit', label: 'Asset Kit', icon: Package },
  { id: 'social', label: 'Social Kit', icon: Share2 },
]

/**
 * Cris's design tools (Phase 12), shown inside the project brief panel on both
 * /collab and the CRM. Everything runs client-side; generated mockups + kits save
 * to Deliverables via the isolated design-assets route (no pipeline side-effect).
 * `onSaved` lets the panel refresh its Deliverables list after a save.
 */
export function DesignToolsSection({
  enrollmentId,
  paletteColors,
  brandName,
  initialGeometry,
  onSaved,
  onGeometrySaved,
}: {
  /** The project to save into. null = scratchpad (Save disabled, export only). */
  enrollmentId: string | null
  paletteColors: NamedColor[]
  /** Public-safe brand name for exported file names (optional). */
  brandName?: string
  /** The project's saved logo geometry, to seed the Geometry tool (optional). */
  initialGeometry?: LogoGeometry | null
  onSaved?: () => void
  /** Called after the Geometry tool writes the choice to the brand profile. */
  onGeometrySaved?: (g: LogoGeometry) => void
}) {
  const [tab, setTab] = useState<Tab>('palette')

  return (
    <div className="space-y-3">
      {/* Intro + built-in help — plain-English guide, mirrors the P&L tool's
          read-me. Native <details> so it stays collapsed and needs no extra JS. */}
      <p className="text-xs text-zinc-500 leading-relaxed">
        Turn this project&apos;s brand brief and AI Brand Profile into ready-to-use colours, mockups and
        logo assets — without leaving the platform. Everything runs in your browser; nothing is sent to
        the client automatically.
      </p>

      <details className="rounded-xl border border-zinc-200 bg-white text-sm text-zinc-700">
        <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-800">
          How these tools work — read me
        </summary>
        <div className="space-y-4 border-t border-zinc-100 px-3 py-3 leading-relaxed text-[13px]">
          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">What it is</h3>
            <p>
              Three design accelerators that help you move from the client&apos;s brand brief to finished
              assets faster. They read the client&apos;s answers and the <strong>AI Brand Profile</strong>{' '}
              (colours, personality, mood) already shown above, and turn them into palettes, in-context
              mockups and a downloadable logo kit. You still create the logo itself in your own software —
              these tools handle everything around it.
            </p>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">The three tools</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Palette</strong> — takes the brand profile colours (or any base colour you pick)
                and generates complementary, analogous, triadic, and lighter/darker variants. Shows hex +
                RGB and <strong>WCAG contrast</strong> ratings (AA/AAA) for accessibility, and exports as
                CSS, SCSS, JSON, Tailwind, or a hex list. Works even before a profile exists.
              </li>
              <li>
                <strong>Mockups</strong> — drop in a logo (upload one, or pick an image already in
                Deliverables) and preview it on a business card, letterhead, social post, and website
                frame, themed to any palette colour. Adjust the size, then <strong>Export PNG</strong> or{' '}
                <strong>Save to Deliverables</strong>.
              </li>
              <li>
                <strong>Geometry</strong> — decide the logo&apos;s shape language: pick a corner style
                (squared, rounded, pill, bevelled, chiseled) and fine-tune it with the{' '}
                <strong>radius</strong> and <strong>sharpness</strong> sliders, themed in a brand colour.{' '}
                <strong>Export SVG/PNG</strong>, <strong>Save to Deliverables</strong>, and{' '}
                <strong>Save to brand</strong> so the choice sticks with the project (and a future logo
                generator can read it).
              </li>
              <li>
                <strong>Asset Kit</strong> — from one logo, generate all the common social sizes (profile,
                Instagram post/story, X header, FB/LinkedIn cover), light/dark/transparent background
                variations, and favicons — bundled into a ZIP with a README. Download it or Save it.
              </li>
              <li>
                <strong>Social Kit</strong> — the client-facing bundle: the logo assets above{' '}
                <em>plus</em> ready-to-post <strong>branded templates</strong> (announcement, tagline,
                launch) built from the brand colours and logo, with your own headline. Download it, or{' '}
                <strong>Generate &amp; send to client</strong> so they can grab it from their portal once
                the project is delivered.
              </li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">How to use it</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Pick a tab. <strong>Palette</strong> works immediately from the AI Brand Profile.</li>
              <li>
                For <strong>Mockups</strong> / <strong>Asset Kit</strong>, add a logo — drag a file in, or
                choose one of the project&apos;s uploaded images.
              </li>
              <li>
                Preview and adjust, then <strong>Export</strong> (downloads to your computer) or{' '}
                <strong>Save to Deliverables</strong> (keeps it on the project).
              </li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-amber-700">Good to know</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Nothing reaches the client automatically.</strong> Saved mockups and kits land in
                this project&apos;s Deliverables under <em>Design tool outputs</em> (download or delete
                only) — they are never released to the client and never appear in the client&apos;s logo
                reveal.
              </li>
              <li>
                <strong>Saving doesn&apos;t change the project.</strong> It never moves the status or stage
                — the pipeline is untouched.
              </li>
              <li>
                <strong>Transparent backgrounds</strong> only appear when the uploaded logo actually has
                transparency (a flat JPG has none).
              </li>
              <li>
                <strong>The AI Logo Concept Generator is coming later</strong> — it needs an
                image-generation service. For now, create the logo in your own software and use these tools
                for everything around it.
              </li>
            </ul>
          </section>
        </div>
      </details>

      <div className="flex items-center gap-1.5">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border',
                tab === t.id
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'palette' && <ColorPaletteTool initialColors={paletteColors} />}
      {tab === 'mockups' && (
        <MockupPreviewer enrollmentId={enrollmentId} paletteColors={paletteColors} geometry={initialGeometry} onSaved={onSaved} />
      )}
      {tab === 'geometry' && (
        <GeometryTool
          enrollmentId={enrollmentId}
          paletteColors={paletteColors}
          brandName={brandName}
          initialGeometry={initialGeometry}
          onSaved={onSaved}
          onGeometrySaved={onGeometrySaved}
        />
      )}
      {tab === 'kit' && <AssetKitTool enrollmentId={enrollmentId} onSaved={onSaved} />}
      {tab === 'social' && (
        <SocialSharingKitTool enrollmentId={enrollmentId} paletteColors={paletteColors} onSaved={onSaved} />
      )}
    </div>
  )
}
