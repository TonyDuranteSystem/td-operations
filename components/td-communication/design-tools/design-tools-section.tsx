'use client'

import { useState } from 'react'
import { Palette, LayoutTemplate, Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NamedColor } from '@/lib/td-communication/color-tools'
import { ColorPaletteTool } from './color-palette-tool'
import { MockupPreviewer } from './mockup-previewer'
import { AssetKitTool } from './asset-kit-tool'

type Tab = 'palette' | 'mockups' | 'kit'

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: 'palette', label: 'Palette', icon: Palette },
  { id: 'mockups', label: 'Mockups', icon: LayoutTemplate },
  { id: 'kit', label: 'Asset Kit', icon: Package },
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
  onSaved,
}: {
  enrollmentId: string
  paletteColors: NamedColor[]
  onSaved?: () => void
}) {
  const [tab, setTab] = useState<Tab>('palette')

  return (
    <div className="space-y-3">
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
        <MockupPreviewer enrollmentId={enrollmentId} paletteColors={paletteColors} onSaved={onSaved} />
      )}
      {tab === 'kit' && <AssetKitTool enrollmentId={enrollmentId} onSaved={onSaved} />}
    </div>
  )
}
