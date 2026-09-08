'use client'

/**
 * Desktop dashboard header — back button, search, and the icon cluster.
 *
 * Antonio, 2026-09-07 (header screenshot): "you can reduce the 'Enable
 * notification', 'Help' and the search bar. The search bar could appear only
 * when we click on it. you could also consider three dots for 'enable
 * notification' and 'help'. so you can put the notes on the top." Search now
 * starts as a small icon and only expands to the full input on focus/click;
 * Help + Enable Notifications move behind a "..." menu; the freed space goes
 * to the new Parked-notes trigger, next to the Alerts bell it's paired with.
 */

import { useEffect, useRef, useState } from 'react'
import { Search, MoreHorizontal } from 'lucide-react'
import { GlobalSearch } from '@/components/shared/global-search'
import { DashboardPushToggle } from '@/components/dashboard/push-toggle'
import { StaffAlertsBell } from '@/components/dashboard/staff-alerts-bell'
import { ParkedNotesTrigger } from '@/components/dashboard/parked-notes-trigger'
import { ActiveNotesStrip } from '@/components/dashboard/active-notes-strip'
import { HelpToggle } from '@/components/help/help-toggle'
import { GlobalBackButton } from '@/components/dashboard/global-back-button'
import { CaptureButton } from '@/components/captures/capture-button'
import { FastTooltip } from '@/components/ui/fast-tooltip'

/**
 * GlobalSearch stays MOUNTED at all times — it has its own always-on Cmd+K
 * listener and listens for a 'focus-global-search' event (already built for
 * the mobile header's search icon; reused here for the same purpose). Only
 * the VISUAL width collapses to icon-size when not in use; a width-0,
 * overflow-hidden input still accepts the programmatic .focus() both of
 * those triggers call, so Cmd+K keeps working even while this looks collapsed.
 * Expands/collapses off real focus (onFocus/onBlur), not a click flag, so
 * Cmd+K and the icon click both land in the same state correctly.
 */
function CollapsibleSearch() {
  const [expanded, setExpanded] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  /**
   * THE FIX for "clicking the icon opens the box but typing goes nowhere"
   * (found live, 2026-09-08): GlobalSearch's own Cmd+K/focus-event handlers
   * call `inputRef.current.focus()` on the SAME synchronous tick that
   * triggers it — before React has committed the width-expansion re-render,
   * so the input is still sitting inside its width-0/overflow-hidden wrapper
   * at the moment focus() runs. That focus attempt was just strong enough to
   * bubble an onFocus up to THIS wrapper (which is how `expanded` correctly
   * flips true either way) but not strong enough to actually STICK as the
   * page's focused element — confirmed live: after clicking the icon, the
   * box visibly opened but `document.activeElement` was `<body>`, not the
   * input, and typed characters went nowhere.
   *
   * Fix: once `expanded` is confirmed true (by ANY path — icon click, Cmd+K,
   * or the mobile-style 'focus-global-search' event), re-focus the actual
   * input here, AFTER React has committed the real (non-clipped) width. This
   * runs for every path uniformly, so it isn't a second, parallel mechanism
   * to keep in sync with GlobalSearch's own attempt — it's just the one that
   * actually lands, every time.
   */
  useEffect(() => {
    if (!expanded) return
    const input = wrapRef.current?.querySelector('input')
    if (input && document.activeElement !== input) input.focus()
  }, [expanded])

  return (
    <div
      ref={wrapRef}
      className={expanded ? 'flex flex-1 max-w-2xl items-center' : 'flex shrink-0 items-center'}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setExpanded(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setExpanded(false); (e.target as HTMLElement).blur() }
      }}
    >
      {!expanded && (
        <FastTooltip label="Search (⌘K)">
          <button
            onClick={() => {
              setExpanded(true) // deterministic for the click path — the effect above does the actual focus once this commits
              document.dispatchEvent(new CustomEvent('focus-global-search')) // keeps GlobalSearch's own open/query state in sync
            }}
            className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100"
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </FastTooltip>
      )}
      <div className={expanded ? 'w-full' : 'w-0 overflow-hidden'}>
        <GlobalSearch searchEndpoint="/api/search" mode="crm" placeholder="Search accounts, contacts, tasks, leads..." />
      </div>
    </div>
  )
}

/**
 * The panel stays MOUNTED at all times (visibility toggled with the `hidden`
 * class, never conditionally rendered) so DashboardPushToggle's
 * `refreshOnMount` effect fires on every dashboard load, exactly as it did
 * when the button sat directly in the header — not just the first time this
 * menu happens to be opened. See push-toggle.tsx: "Should be enabled on
 * exactly ONE instance per dashboard render (we mount it on the desktop
 * header)" — that instance is still here, just tucked behind this menu.
 */
function OverflowMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <FastTooltip label="More">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100"
          aria-label="More options"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </FastTooltip>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      <div className={`absolute right-0 top-full z-50 mt-2 flex w-56 flex-col gap-2 rounded-lg border bg-white p-3 shadow-lg ${open ? '' : 'hidden'}`}>
        <HelpToggle />
        <DashboardPushToggle refreshOnMount />
      </div>
    </div>
  )
}

export function DashboardHeader() {
  return (
    <header className="hidden lg:flex sticky top-0 z-30 h-14 items-center border-b bg-white/80 backdrop-blur-sm px-6 gap-3">
      <GlobalBackButton className="-ml-2" />
      <CollapsibleSearch />
      <div className="flex-1" />
      <ActiveNotesStrip />
      <ParkedNotesTrigger />
      <StaffAlertsBell />
      <CaptureButton />
      <OverflowMenu />
    </header>
  )
}
