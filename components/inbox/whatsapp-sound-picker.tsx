'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { SOUND_LIBRARY, SOUND_NONE, useNotificationSound } from '@/lib/hooks/use-notification-sound'
import { readSoundPref, writeSoundPref, WA_SOUND_DEFAULT } from '@/lib/whatsapp-sound'

/**
 * "Which sound do I hear for a new WhatsApp message?" — a small speaker button in the WhatsApp Inbox bar (dev job c84dfb4d).
 * Each person picks their own tone, or Off. The choice lives in THIS browser (localStorage), so a second computer asks once.
 * Clicking a tone also plays it, so the pick is heard before it is kept. The sound itself is played by the dashboard's
 * UiEventListener whenever a fresh customer message arrives, whichever page is open.
 */
export function WhatsAppSoundPicker() {
  const [pref, setPref] = useState<string>(WA_SOUND_DEFAULT)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const { previewSound } = useNotificationSound()

  useEffect(() => {
    setPref(readSoundPref(typeof window === 'undefined' ? null : window.localStorage))
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (id: string) => {
    setPref(id)
    writeSoundPref(window.localStorage, id)
    if (id !== SOUND_NONE) previewSound(id)
  }

  const off = pref === SOUND_NONE

  return (
    <div ref={boxRef} className="relative flex items-center border-l pl-2 ml-1" data-testid="wa-sound-picker">
      <FastTooltip label={off ? 'WhatsApp message sound: off' : 'WhatsApp message sound'}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-label="WhatsApp message sound"
          aria-expanded={open}
          className={cn('p-1.5 rounded transition-colors hover:bg-zinc-100', off ? 'text-zinc-400' : 'text-green-600')}
        >
          {off ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </FastTooltip>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 rounded-md border bg-white py-1 shadow-lg">
          <p className="px-3 py-1 text-[11px] text-zinc-500">Sound for a new WhatsApp message (this browser)</p>
          {[...SOUND_LIBRARY.map(s => ({ id: s.id, label: s.label })), { id: SOUND_NONE, label: 'Off' }].map(s => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={pref === s.id}
              data-testid={`wa-sound-${s.id}`}
              onClick={() => choose(s.id)}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-zinc-50"
            >
              <span>{s.label}</span>
              {pref === s.id && <Check className="h-3.5 w-3.5 text-green-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
