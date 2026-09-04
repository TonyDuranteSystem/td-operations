'use client'

/**
 * The Capture entry point — a fixed top-bar icon, deliberately NOT a floating
 * button (Antonio, 2026-09-04: "instead of a floating add just a button next
 * to enable notification on top"). Placed next to DashboardPushToggle on
 * purpose: that bar is already global chrome on every dashboard page, both
 * desktop and the mobile top bar, which sidesteps the small-phone-screen FAB
 * crowding the UX review flagged (notes + chat already claim the only two
 * safe floating-corner slots).
 *
 * One button, two things behind it (Antonio: "one button for both"): a tap
 * opens a tiny menu — start a new capture (opens CaptureLayer), or jump to
 * the full "My Captures" page (step 7). Same styling shape as
 * DashboardPushToggle's own compact/full split, for visual consistency.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRouter } from 'next/navigation'
import { Camera, Images } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { useCapture } from '@/components/captures/capture-provider'

export function CaptureButton({ compact = false }: { compact?: boolean }) {
  const { open } = useCapture()
  const router = useRouter()

  const triggerClassName = compact
    ? 'p-2 rounded-md text-zinc-500 hover:bg-zinc-100 transition-colors'
    : 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors bg-zinc-100 text-zinc-600 border border-zinc-200 hover:bg-zinc-200'

  const trigger = (
    <button className={triggerClassName} aria-label="Capture a screenshot">
      <Camera className={compact ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
      {!compact && 'Capture'}
    </button>
  )

  return (
    <DropdownMenu.Root>
      <FastTooltip label="Capture a screenshot, or see your past ones">
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      </FastTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50"
          align="end"
          sideOffset={4}
        >
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 outline-none hover:bg-zinc-50"
            onSelect={open}
          >
            <Camera className="h-3.5 w-3.5 text-zinc-400" />
            New capture
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 outline-none hover:bg-zinc-50"
            onSelect={() => router.push('/captures')}
          >
            <Images className="h-3.5 w-3.5 text-zinc-400" />
            My captures
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
