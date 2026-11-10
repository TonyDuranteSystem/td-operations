'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Camera, Paperclip } from 'lucide-react'
import { useTalkI18n } from '@/components/talk/talk-i18n'
import { chooseMenuSide, nearestClippingAncestor, type MenuSide } from '@/lib/scan/menu-side'

/**
 * The small menu the paperclip opens: "Scan document" (the camera, one PDF) or "Photo or file" (exactly what the paperclip did
 * before). Put it inside a `relative` wrapper around the paperclip button; it opens upwards by default (above a message box), or downwards with `placement="below"`.
 * Closes on a tap outside or Escape. Both choices run straight from the tap, so the phone's file picker still opens.
 */
export function AttachChoiceMenu({ open, onClose, onScan, onFile, align = 'left', placement = 'above' }: {
  open: boolean
  onClose: () => void
  onScan: () => void
  onFile: () => void
  align?: 'left' | 'right'
  /** 'above' (default) suits a message box at the bottom of the screen; 'below' suits a row near the top of a dialog */
  placement?: 'above' | 'below'
}) {
  const { t } = useTalkI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<MenuSide>(placement)

  // Open on the asked-for side, then — before anything is painted — flip if that side has no room (the phone app's Reply screen
  // scrolls under a header, and an upward menu lost its top row there).
  useLayoutEffect(() => {
    if (!open) { setSide(placement); return }
    const menu = ref.current
    const wrapper = menu?.parentElement
    if (!menu || !wrapper) return
    const w = wrapper.getBoundingClientRect()
    const clip = nearestClippingAncestor(wrapper)
    const c = clip ? clip.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    setSide(chooseMenuSide(placement, w.top - c.top, c.bottom - w.bottom, menu.offsetHeight))
  }, [open, placement])

  useEffect(() => {
    if (!open) return
    // "outside" = outside the paperclip's wrapper too, so tapping the paperclip itself is left to its own toggle
    const outside = (e: PointerEvent) => {
      const wrapper = ref.current?.parentElement
      if (wrapper && !wrapper.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key) }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      ref={ref} role="menu" aria-label={t('Attach')} data-testid="attach-choice-menu"
      className={`absolute z-30 w-64 ${side === 'below' ? 'top-full mt-2' : 'bottom-full mb-2'} overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <button type="button" role="menuitem" onClick={onScan} data-testid="attach-scan" className="flex w-full items-center gap-3 border-b border-zinc-100 px-3.5 py-3 text-left hover:bg-zinc-50 active:bg-zinc-100">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-[#BE1E2D]"><Camera className="h-5 w-5" /></span>
        <span className="min-w-0"><span className="block text-sm font-semibold">{t('Scan document')}</span><span className="block text-xs text-zinc-500">{t('Camera to one PDF')}</span></span>
      </button>
      <button type="button" role="menuitem" onClick={onFile} data-testid="attach-file" className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-zinc-50 active:bg-zinc-100">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600"><Paperclip className="h-5 w-5" /></span>
        <span className="min-w-0"><span className="block text-sm font-semibold">{t('Photo or file')}</span><span className="block text-xs text-zinc-500">{t('Take photo, Photo Library, Files')}</span></span>
      </button>
    </div>
  )
}
