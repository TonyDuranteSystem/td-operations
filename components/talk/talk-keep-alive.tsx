'use client'

import { useEffect } from 'react'
import { KEEP_ALIVE_GAIN, KEEP_ALIVE_HZ, keepAliveWanted } from '@/lib/talk/keep-alive'
import { isTalkVoiceOn, isTalkPageTouched, TALK_VOICE_CHANGE } from '@/components/talk/talk-voice'

/**
 * Renders nothing. While TD Talk's Voice is On and the page has been touched, plays a tone too low and quiet to hear so Chrome keeps this tab awake in the background
 * (see lib/talk/keep-alive.ts). Stops when Voice is switched Off. A browser without Web Audio simply does nothing.
 */
export function TalkVoiceKeepAlive() {
  useEffect(() => {
    let ctx: AudioContext | null = null
    let osc: OscillatorNode | null = null

    const stop = () => {
      try { osc?.stop() } catch { /* already stopped */ }
      try { void ctx?.close() } catch { /* already closed */ }
      osc = null; ctx = null
    }
    const sync = () => {
      const want = keepAliveWanted(isTalkVoiceOn(), isTalkPageTouched())
      if (!want) { if (ctx) stop(); return }
      try {
        if (!ctx) {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (!AC) return
          ctx = new AC()
          const gain = ctx.createGain()
          gain.gain.value = KEEP_ALIVE_GAIN
          osc = ctx.createOscillator()
          osc.frequency.value = KEEP_ALIVE_HZ
          osc.connect(gain)
          gain.connect(ctx.destination)
          osc.start()
        }
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
      } catch { stop() }
    }

    sync()
    // the first click/key makes sound allowed; Voice switched On/Off; the tab coming back (Chrome may have suspended the context)
    const events: Array<[EventTarget, string]> = [[window, 'pointerdown'], [window, 'keydown'], [window, TALK_VOICE_CHANGE], [window, 'storage'], [document, 'visibilitychange'], [window, 'focus']]
    for (const [t, e] of events) t.addEventListener(e, sync, { capture: true })
    const timer = setInterval(sync, 30_000)
    return () => {
      for (const [t, e] of events) t.removeEventListener(e, sync, { capture: true })
      clearInterval(timer)
      stop()
    }
  }, [])
  return null
}
