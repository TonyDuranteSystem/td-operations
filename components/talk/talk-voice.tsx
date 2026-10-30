'use client'

import { useCallback, useEffect, useState } from 'react'
import { TALK_VOICE_KEY, shouldSpeakTalkPhrase, talkVoiceIsOn, talkVoicePhrase } from '@/lib/talk/voice-alert'

/**
 * TD Talk — the spoken alert for a new direct or group message (Antonio, 30 Oct 2026). `speakTalkMessage` is called by the CRM's realtime notifications INSTEAD of the beep;
 * `TalkVoiceSwitch` (On/Off, in TD Talk's chat list — the phone app and the CRM tab) and `TalkVoiceWakeBar` ("click anywhere to start") are the screen parts. See lib/talk/voice-alert.ts.
 */

const CHANGE = 'td-talk-voice-change'
// The choice is also kept in memory, so a browser that blocks storage (private mode) still lets the person turn the voice off for this page.
let memoryChoice: string | null = null
const read = (): string | null => { try { return window.localStorage.getItem(TALK_VOICE_KEY) ?? memoryChoice } catch { return memoryChoice } }
const write = (v: string) => { memoryChoice = v; try { window.localStorage.setItem(TALK_VOICE_KEY, v) } catch { /* the choice is only a convenience */ } }
const voiceOn = () => talkVoiceIsOn(read())

let lastSpoken: { key: string; at: number } | null = null

function say(text: string, onFail?: () => void): boolean {
  try {
    const s = window.speechSynthesis
    if (!s) return false
    // a browser that left its voice paused (a tab open for hours, an interrupted phone) accepts the words and says nothing: wake it first
    if (s.paused) s.resume()
    const u = new SpeechSynthesisUtterance(text)
    // a deliberate cancel (Voice switched Off, a newer phrase taking over) is not a failure: no beep for it
    if (onFail) u.onerror = e => { if (e.error === 'canceled' || e.error === 'interrupted') return; onFail() }
    u.lang = 'en-US'
    const v = s.getVoices().find(x => /^en/i.test(x.lang))
    if (v) u.voice = v
    s.speak(u)
    return true
  } catch { return false }
}

/** Has the person touched this page yet? Until then the browser keeps any page silent. A browser that cannot say counts as "yes". */
function touchedNow(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  return ua ? ua.hasBeenActive : true
}

/**
 * Says "New <first name> message in TD Talk". Returns true when the message was handled by the voice (spoken, or the same person's phrase just said a moment ago),
 * false when the caller should play the beep instead (Sound off, no speech in this browser, or the page has not been touched yet).
 * `phraseOverride` replaces the words (the "New implementation" chat says its own phrase whoever wrote). `fallback` is the beep: it runs if the browser accepts the words and then reports that it could not say them, so a failed voice is never a silent message.
 */
export function speakTalkMessage(senderName: string | null | undefined, senderId: string | null | undefined, fallback: () => void, phraseOverride?: string): boolean {
  if (typeof window === 'undefined' || !voiceOn() || !touchedNow()) return false
  const phrase = phraseOverride ?? talkVoicePhrase(senderName)
  const key = `${phraseOverride ? '' : (senderId ?? senderName ?? '')}|${phrase}`
  const now = Date.now()
  if (!shouldSpeakTalkPhrase(lastSpoken, key, now)) return true
  // a failed voice must not silence the next message: forget it was spoken, then beep
  const failed = () => { lastSpoken = null; fallback() }
  if (!say(phrase, failed)) return false
  lastSpoken = { key, at: now }
  return true
}

/** The "click anywhere to start" bar: shown only while Sound is on and nobody has touched the page yet. */
export function TalkVoiceWakeBar() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const sync = () => setShow(voiceOn() && !touchedNow())
    sync()
    const wake = () => setShow(false)
    window.addEventListener(CHANGE, sync)
    window.addEventListener('pointerdown', wake, { once: true, capture: true })
    window.addEventListener('keydown', wake, { once: true, capture: true })
    return () => { window.removeEventListener(CHANGE, sync); window.removeEventListener('pointerdown', wake, { capture: true }); window.removeEventListener('keydown', wake, { capture: true }) }
  }, [])
  if (!show) return null
  return (
    <div role="status" data-testid="talk-voice-wake-bar" className="fixed left-1/2 top-10 z-[60] -translate-x-1/2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow">
      🔔 Sound is on. Tap anywhere to start the voice.
    </div>
  )
}

/** The Sound On/Off button. Turning it on says a short test phrase (it is also the click the browser needs). */
export function TalkVoiceSwitch() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    setOn(voiceOn())
    const sync = () => setOn(voiceOn())
    window.addEventListener('storage', sync)
    window.addEventListener(CHANGE, sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(CHANGE, sync) }
  }, [])
  const toggle = useCallback(() => {
    const next = !voiceOn()
    write(next ? 'on' : 'off')
    if (next) say('Sound on')
    else { try { window.speechSynthesis?.cancel() } catch { /* silent */ } }
    setOn(next)
    window.dispatchEvent(new Event(CHANGE))
  }, [])
  if (on === null) return null
  return (
    <button type="button" onClick={toggle} aria-pressed={on} data-testid="talk-voice-switch"
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium ${on ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-zinc-200 text-zinc-600 active:bg-zinc-100'}`}>
      🔔 Voice: {on ? 'On' : 'Off'}
    </button>
  )
}
