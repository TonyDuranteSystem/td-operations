// Did a real conversation happen on this recording? (dev job 6fc63c52, Antonio 2026-11-02: "it's not a matter of time but
// what we said in the call"). Pure: looks ONLY at the one recording's own transcript and attendee list, never at the lead's
// other recordings. No AI: who spoke and how much, from the speaker-labelled transcript Circleback sends.
//
// A real call has at least two different voices that each said something. A mistaken connection, a no-show that left the
// room open, or a staff member talking alone has one voice (the notetaker does not appear in the transcript). On the 70
// speaker rows of the last 120 days of lead calls, the quietest second voice said 293 words; the floors below sit far under
// that, so a short real call passes and an empty room does not.

export const MIN_VOICE_WORDS = 100
export const MIN_VOICE_TURNS = 5

export interface Substance {
  enough: boolean
  /** speakers that said at least the floor, by words spoken */
  voices: { speaker: string; words: number; turns: number }[]
  /** one sentence a person can read on the lead ("Antonio Durante 1257 words, Pierre L 586 words") */
  reason: string
}

interface Line { speaker?: unknown; text?: unknown }

function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

function normName(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Names of attendees that are staff (internal email) or the notetaker bot, so their lines never count as the lead's side. */
export function staffNames(attendees: unknown, isInternal: (email: string) => boolean): string[] {
  const out: string[] = []
  if (!Array.isArray(attendees)) return out
  for (const a of attendees as { name?: unknown; email?: unknown }[]) {
    if (!a || typeof a !== 'object') continue
    const name = typeof a.name === 'string' ? normName(a.name) : ''
    if (!name) continue
    const email = typeof a.email === 'string' ? a.email.trim().toLowerCase() : ''
    if (/notetaker|fireflies|otter|circleback/.test(name) || (email.indexOf('@') > 0 && isInternal(email))) out.push(name)
  }
  return out
}

function isStaffSpeaker(speaker: string, staff: string[]): boolean {
  const s = normName(speaker)
  if (!s) return false
  return staff.some(n => n === s || s.indexOf(n) !== -1 || n.indexOf(s) !== -1)
}

/**
 * Judge one recording. `null` means it cannot be judged (no usable transcript); the caller treats that like "not shown",
 * so the lead stays and asks a person.
 */
export function assessSubstance(transcript: unknown, attendees: unknown, isInternal: (email: string) => boolean): Substance | null {
  if (!Array.isArray(transcript) || transcript.length === 0) return null
  const staff = staffNames(attendees, isInternal)
  const bySpeaker = new Map<string, { words: number; turns: number }>()
  for (const l of transcript as Line[]) {
    if (!l || typeof l !== 'object') continue
    const speaker = typeof l.speaker === 'string' ? l.speaker.trim() : ''
    const text = typeof l.text === 'string' ? l.text : ''
    if (!speaker || !text) continue
    const cur = bySpeaker.get(speaker) ?? { words: 0, turns: 0 }
    cur.words += wordCount(text)
    cur.turns += 1
    bySpeaker.set(speaker, cur)
  }
  if (bySpeaker.size === 0) return null

  const voices = Array.from(bySpeaker.entries())
    .map(([speaker, v]) => ({ speaker, words: v.words, turns: v.turns }))
    .filter(v => v.words >= MIN_VOICE_WORDS && v.turns >= MIN_VOICE_TURNS)
    .sort((a, b) => b.words - a.words)
  const others = voices.filter(v => !isStaffSpeaker(v.speaker, staff))

  const list = voices.map(v => `${v.speaker} ${v.words} words`).join(', ')
  if (voices.length >= 2 && others.length >= 1) {
    return { enough: true, voices, reason: `${others[0].speaker} and the team both spoke at length (${list}).` }
  }
  const everyone = Array.from(bySpeaker.entries()).map(([s, v]) => `${s} ${v.words} words`).join(', ')
  return {
    enough: false,
    voices,
    reason: voices.length < 2
      ? `Only one voice said anything substantial on this recording (${everyone}).`
      : `Only the team spoke on this recording (${list}); nobody from the lead's side said much.`,
  }
}
