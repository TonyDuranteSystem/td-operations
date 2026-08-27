'use client'

/**
 * HelpToggle — the global "Show help" switch in the dashboard header. Flips the
 * help mode so the little "i" HelpDots appear/disappear across the CRM. Lives in
 * the header (not floating) so it never overlaps other UI. See sysdoc help-system-plan.
 */

import { HelpCircle } from 'lucide-react'
import { useHelp } from './help-provider'
import { FastTooltip } from '@/components/ui/fast-tooltip'

export function HelpToggle() {
  const { helpOn, toggle } = useHelp()
  return (
    <FastTooltip label={helpOn ? 'Hide the help buttons' : 'Show help buttons next to features'}>
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          helpOn ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-zinc-600 border-zinc-200 hover:text-zinc-900'
        }`}
        aria-label={helpOn ? 'Hide the help buttons' : 'Show help buttons next to features'}
        aria-pressed={helpOn}
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {helpOn ? 'Help: on' : 'Help'}
      </button>
    </FastTooltip>
  )
}
