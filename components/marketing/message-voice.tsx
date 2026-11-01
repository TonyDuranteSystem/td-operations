'use client'

import { useCallback, useEffect, useState } from 'react'
import { clipUrlFor, playClipQueued, soundAllowedWithoutClick } from '@/lib/voice-clips'
import { VOICE_KEYS, VOICE_POLL_MS, notSpokenYet, parseSpoken, rememberSpoken, voicePhrases, type VoiceAlertItem } from '@/lib/marketing/voice-alert'

/**
 * TD Marketing — the spoken alert for a new message (dev job 9aec66fa; Antonio, 29 Oct 2026: "notification with sound for new messages, the sound must say Message from Rocco").
 * Two pieces: `MessageVoice` (mounted once in the CRM and once in the team's workspace; renders nothing) asks the server every few seconds whether somebody wrote to this person, and says
 * "Message from <first name>" with the browser's own voice; `VoiceSwitch` is the on/off button in the menus. Only a person who switched Sound on in THIS browser is ever asked about, and a login
 * that is not part of a team is told no once and the page stops asking. The browser lets a page speak only after the person has clicked on it, and a closed browser cannot speak at all (the push
 * notification covers that).
 */

const CHANGE = 'tdm-voice-change'
const read = (k: string): string | null => { try { return window.localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { window.localStorage.setItem(k, v) } catch { /* the choice is only a convenience */ } }
const drop = (k: string) => { try { window.localStorage.removeItem(k) } catch { /* the choice is only a convenience */ } }
const voiceOn = () => read(VOICE_KEYS.on) === 'on'

/** Says the words in English with the first English voice the browser has. A page that cannot speak stays silent. */
function say(text: string): void {
  // a recorded clip when there is one (one after the other); the browser voice when there is none, or when the browser refuses the clip
  const clip = clipUrlFor(text)
  if (clip) { playClipQueued(clip, () => speak(text)); return }
  speak(text)
}

function speak(text: string): void {
  try {
    const s = window.speechSynthesis
    if (!s) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    const v = s.getVoices().find(x => /^en/i.test(x.lang))
    if (v) u.voice = v
    s.speak(u)
  } catch { /* silent */ }
}

/** One look at the server: what came in since the last look, read out once for the whole browser (every tab shares the clock and the list of what was said). */
async function lookOnce(): Promise<'ok' | 'stop'> {
  const since = read(VOICE_KEYS.since)
  const res = await fetch(`/api/marketing/chat/alerts${since ? `?since=${encodeURIComponent(since)}` : ''}`, { cache: 'no-store' }).catch(() => null)
  if (!res) return 'ok'
  if (res.status === 401 || res.status === 403) return 'stop'
  if (!res.ok) return 'ok'
  const d = (await res.json().catch(() => null)) as { now?: string; items?: VoiceAlertItem[] } | null
  if (!d?.now) return 'ok'
  const known = parseSpoken(read(VOICE_KEYS.spoken))
  const fresh = notSpokenYet(d.items ?? [], known)
  write(VOICE_KEYS.since, d.now)
  if (fresh.length > 0) {
    write(VOICE_KEYS.spoken, JSON.stringify(rememberSpoken(known, fresh.map(i => i.id))))
    for (const p of voicePhrases(fresh)) say(p)
  }
  return 'ok'
}

/** Only one tab of the browser looks at a time (the lock), so two open tabs never say the same message twice; a browser without locks relies on the remembered ids. */
async function lookAlone(): Promise<'ok' | 'stop'> {
  const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<'ok' | 'stop'>) => Promise<'ok' | 'stop'> } }).locks
  if (!locks) return lookOnce()
  return locks.request('tdm-voice-look', { ifAvailable: true }, async lock => (lock ? lookOnce() : 'ok'))
}

/** Has the person touched this page yet (a click or a key)? Until then the browser keeps any page silent. A browser that cannot say is taken as "yes", so no bar is ever shown for nothing. */
function useTouched(): boolean {
  const [touched, setTouched] = useState(true)
  useEffect(() => {
    // a browser that already lets a recorded clip start without a click (Site settings, Sound, Allow) needs no bar
    void soundAllowedWithoutClick().then(ok => { if (ok) setTouched(true) })
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
    setTouched(ua ? ua.hasBeenActive : true)
    const wake = () => setTouched(true)
    window.addEventListener('pointerdown', wake, { once: true, capture: true })
    window.addEventListener('keydown', wake, { once: true, capture: true })
    return () => { window.removeEventListener('pointerdown', wake, { capture: true }); window.removeEventListener('keydown', wake, { capture: true }) }
  }, [])
  return touched
}

/** Renders the "click anywhere to start" bar while Sound is on and nobody has touched the page, and otherwise nothing. */
export function MessageVoice({ wakeText = 'Sound is on. Click anywhere on this page to start it.' }: { wakeText?: string }) {
  const [on, setOn] = useState(false)
  const touched = useTouched()
  useEffect(() => {
    setOn(voiceOn())
    const sync = () => setOn(voiceOn())
    const storage = (e: StorageEvent) => { if (e.key === VOICE_KEYS.on) sync() }
    window.addEventListener(CHANGE, sync)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener(CHANGE, sync); window.removeEventListener('storage', storage) }
  }, [])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let busy = false
    const look = async () => {
      if (stopped || busy || !voiceOn()) return
      busy = true
      try { if ((await lookAlone()) === 'stop') stopped = true } finally { busy = false }
    }
    const loop = async () => { await look(); if (!stopped) timer = setTimeout(loop, VOICE_POLL_MS) }
    timer = setTimeout(loop, 1500)
    // coming back to a hidden tab, or switching Sound on: look right away instead of waiting for the next round
    const now = () => { void look() }
    const visible = () => { if (document.visibilityState === 'visible') now() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener(CHANGE, now)
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener(CHANGE, now) }
  }, [])
  if (!on || touched) return null
  return (
    <div role="status" data-testid="voice-wake-bar" className="fixed left-1/2 top-10 z-[60] -translate-x-1/2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow">
      🔔 {wakeText}
    </div>
  )
}

/** The Sound on/off button for the menus. The label words come from the menu (English in Antonio's, his language in the team's). */
export function VoiceSwitch({ label = 'Sound', onText = 'On', offText = 'Off' }: { label?: string; onText?: string; offText?: string }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(voiceOn())
    const sync = (e: StorageEvent) => { if (e.key === VOICE_KEYS.on) setOn(voiceOn()) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const toggle = useCallback(() => {
    const next = !on
    write(VOICE_KEYS.on, next ? 'on' : 'off')
    if (next) { drop(VOICE_KEYS.since); say('Sound on') } else { try { window.speechSynthesis?.cancel() } catch { /* silent */ } }
    setOn(next)
    window.dispatchEvent(new Event(CHANGE))
  }, [on])
  return (
    <div className="mt-2 px-3">
      <button type="button" onClick={toggle} aria-pressed={on} data-testid="voice-switch"
        className={`rounded px-2 py-1 text-xs ${on ? 'bg-teal-50 font-semibold text-teal-800' : 'text-slate-500 hover:bg-slate-100'}`}>
        🔔 {label}: {on ? onText : offText}
      </button>
    </div>
  )
}
