'use client'

import { Eye } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'

/**
 * Persistent read-only banner shown across the top of the portal while an admin
 * is viewing as a client. The Exit link hits the GET exit route that tears down
 * the minted session.
 *
 * Mobile stacking: this banner is `sticky top-0 z-[100]`, and the portal's
 * mobile nav bar (PortalSidebar) is `fixed top-0 z-40`. Both want the top strip,
 * so without coordination the banner covers the hamburger menu and the menu
 * becomes unreachable on phones (bug found 2026-06-27 in View-as on mobile).
 * To avoid hard-coding a height (the banner wraps to two lines on narrow
 * screens), we MEASURE the rendered banner and publish it as the CSS variable
 * `--portal-vb-h` on <html>; the mobile nav bar reads it to offset its own
 * `top` so it sits just below the banner. The var is reset to 0px on unmount
 * (i.e. when the admin exits View-as), so the normal client layout is untouched.
 */
export function ViewAsBanner({ clientName }: { clientName: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--portal-vb-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--portal-vb-h', '0px')
    }
  }, [])

  return (
    <div
      ref={ref}
      className="sticky top-0 z-[100] flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white shadow-md"
    >
      <Eye className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{clientName}</strong> — <strong>READ ONLY</strong>. Actions are disabled.
      </span>
      <a
        href="/portal/view-as/exit"
        className="ml-2 shrink-0 rounded-md bg-white/20 px-3 py-1 font-semibold underline-offset-2 hover:bg-white/30"
      >
        Exit
      </a>
    </div>
  )
}
