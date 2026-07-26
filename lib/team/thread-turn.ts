/**
 * Team Workspace — per-thread "whose turn is it" read receipt (pure, unit-tested).
 *
 * For each thread root, given the LAST message in it plus every read pointer on
 * that root, decide what the viewer should see:
 *  - 'waiting_you'  someone else wrote last and the viewer hasn't opened it yet
 *  - 'waiting_them' the viewer (or the AI on the team's behalf) wrote last and
 *                   nobody on the other side has read it yet
 *  - 'seen'         our last message has been read by someone else
 *  - 'none'         nothing to show (viewer already caught up on an incoming
 *                   message, or the thread has no resolvable last message)
 *
 * ROSTER-FREE by design. "The other side" is NOT a fixed staff list — it is
 * simply "any reader that is neither the viewer nor the AI". Verified 2026-07-26
 * that the active team is exactly two humans (Antonio + Luca) plus the AI, and
 * that the auth directory also carries dormant accounts; keying "seen" off that
 * directory would leave every outgoing thread stuck at "not seen" forever (a
 * dormant account never reads). Internal threads are staff-only, so any read
 * pointer that is not the viewer's and not the AI's belongs to the other teammate.
 *
 * KNOWN LIMITATION (accepted, both reviewers, 2026-07-26): because ANY non-viewer,
 * non-AI reader flips "seen", a non-teammate staff login that opens a thread — the
 * QA admin account during testing, most notably — counts as "the teammate" and can
 * show "seen" before the real recipient (Luca) has read it. Correct in day-to-day
 * (only Antonio + Luca read); the wobble is confined to QA under a test login.
 * Verify the "seen" flip with Luca's actual account, not the QA admin.
 *
 * An AI message (sender === aiSenderId) counts as OUR side — Antonio asked to see
 * "waiting for Luca" after telling the AI to reply on the team's behalf.
 * Documented caveat: on the OTHER teammate's own screen an AI reply also reads as
 * "our side", so a reply the AI sent to answer them shows as waiting-on-them; the
 * normal unread dot still flags that it is new for them.
 */

export type ThreadReadState = 'waiting_you' | 'waiting_them' | 'seen' | 'none'

export interface LastMessage {
  sender_id: string
  created_at: string
}

export interface ThreadTurn {
  read_state: ThreadReadState
  /** For 'waiting_them', the other participant(s) we're waiting on (comma-joined
   *  first names). Null for every other state, or when no name is resolvable. */
  waiting_name: string | null
}

export interface ComputeTurnArgs {
  /** The newest non-deleted message per thread root (root message or last reply). */
  lastByRoot: Map<string, LastMessage>
  /** The viewer (whoever is looking at the list). */
  viewerId: string
  /** The AI's sender id — its messages count as the team's (our) side. */
  aiSenderId: string
  /** readsByRoot[rootId] = Map(userId → last_read_at ISO). Every read pointer on
   *  the root, viewer included. A missing entry means that user never read it. */
  readsByRoot: Map<string, Map<string, string>>
  /** rootId → the set of user ids that have posted in or read that root. Used
   *  only to NAME whom we're waiting on. Viewer/AI are filtered out here. */
  participantsByRoot: Map<string, Set<string>>
  /** userId → display name, for the waiting label. */
  nameById: Map<string, string>
}

function firstName(name: string): string {
  const trimmed = (name || '').trim()
  return trimmed.split(/\s+/)[0] || trimmed
}

/**
 * True if read-pointer time `readAt` is at or after message time `at`. Compared
 * as real instants (parsed epoch millis), not as strings — the two values can be
 * written in different ISO shapes ('…Z' from JS vs '…+00:00' from Postgres), and
 * string ordering of those is not chronological. An unparseable value is treated
 * as "not read".
 */
function reachedAtOrAfter(readAt: string | undefined, at: string): boolean {
  if (!readAt) return false
  const r = Date.parse(readAt)
  const a = Date.parse(at)
  if (Number.isNaN(r) || Number.isNaN(a)) return false
  return r >= a
}

/**
 * True if any read pointer that is NOT the viewer and NOT the AI reached (or
 * passed) the given time — i.e. the other teammate has seen our message.
 */
function seenByOther(
  reads: Map<string, string> | undefined,
  at: string,
  viewerId: string,
  aiSenderId: string,
): boolean {
  if (!reads) return false
  let seen = false
  reads.forEach((lastRead, uid) => {
    if (uid === viewerId || uid === aiSenderId) return
    if (reachedAtOrAfter(lastRead, at)) seen = true
  })
  return seen
}

export function computeThreadTurn(args: ComputeTurnArgs): Record<string, ThreadTurn> {
  const { lastByRoot, viewerId, aiSenderId, readsByRoot, participantsByRoot, nameById } = args
  const out: Record<string, ThreadTurn> = {}

  lastByRoot.forEach((last, rootId) => {
    const reads = readsByRoot.get(rootId)
    const isOurs = last.sender_id === viewerId || last.sender_id === aiSenderId

    if (!isOurs) {
      // Last message came from the other side → the viewer owes a read.
      const seenByViewer = reachedAtOrAfter(reads?.get(viewerId), last.created_at)
      out[rootId] = seenByViewer
        ? { read_state: 'none', waiting_name: null }
        : { read_state: 'waiting_you', waiting_name: null }
      return
    }

    // Our side wrote last (viewer or the AI on our behalf).
    if (seenByOther(reads, last.created_at, viewerId, aiSenderId)) {
      out[rootId] = { read_state: 'seen', waiting_name: null }
      return
    }

    // Nobody else has read it yet — name the other participant(s), if known.
    const others = participantsByRoot.get(rootId)
    let waiting_name: string | null = null
    if (others && others.size > 0) {
      const names = Array.from(others)
        .filter(uid => uid !== viewerId && uid !== aiSenderId)
        .map(uid => firstName(nameById.get(uid) || ''))
        .filter(Boolean)
      if (names.length > 0) waiting_name = Array.from(new Set(names)).join(', ')
    }
    out[rootId] = { read_state: 'waiting_them', waiting_name }
  })

  return out
}
