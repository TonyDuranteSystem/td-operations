'use client'

import { useEffect, useState } from 'react'
import { OWN_NEWEST_NOTE } from '@/lib/release/own-release'
import { parseNotesJson, type ReleaseNote } from '@/lib/release/release-notes'

/** If the live site cannot answer yet (a rollout in progress), ask again this many times, this far apart. */
const RETRIES = 3
const RETRY_MS = 15_000

/**
 * What the announced release changes (dev job 616dc839). `live` is the release id the update bar is announcing (null = no bar).
 * Asked ONCE when the bar appears (and a few more times if the answer did not come from that release yet) — never on the minute poll.
 * Any failure → no description, and the bar still works exactly as before: a missing note is never an error.
 */
export function useReleaseNotes(live: string | null): { notes: ReleaseNote[]; more: number } {
  const [view, setView] = useState<{ forLive: string | null; notes: ReleaseNote[]; more: number }>({ forLive: null, notes: [], more: 0 })

  useEffect(() => {
    if (!live || !OWN_NEWEST_NOTE) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const load = async (attempt: number) => {
      try {
        // redirect: 'manual' — an ended session answers with a redirect to the login page; that must read as "no answer".
        const res = await fetch(`/api/release/notes?since=${encodeURIComponent(OWN_NEWEST_NOTE)}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' })
        if (res.ok) {
          const data = (await res.json()) as { version?: unknown; notes?: unknown; more?: unknown }
          // only the release being announced may describe itself (during a rollout an older instance may answer first)
          if (data.version === live && Array.isArray(data.notes)) {
            const notes = parseNotesJson(JSON.stringify(data.notes)).reverse()
            if (alive) setView({ forLive: live, notes, more: typeof data.more === 'number' ? data.more : 0 })
            return
          }
        }
      } catch {
        /* offline or a damaged answer: try again below */
      }
      if (alive && attempt < RETRIES) timer = setTimeout(() => { void load(attempt + 1) }, RETRY_MS)
    }

    void load(0)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [live])

  // notes belong to the release they were asked for; a newer announced release starts empty until its own answer arrives
  return view.forLive === live ? { notes: view.notes, more: view.more } : { notes: [], more: 0 }
}
