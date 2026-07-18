/**
 * Team Workspace — Slack-thread metadata (pure, unit-tested).
 *
 * Given the reply rows of a channel and the caller's per-root read pointers,
 * compute per-thread reply_count / last_reply / unread. Kept pure so the read
 * route can stay thin and the tricky unread rule is testable.
 *
 * A message with root_id set is a REPLY belonging to thread <root_id>. A message
 * with root_id NULL is a thread ROOT (or a plain top-level message with no
 * replies yet).
 */

export interface ReplyRow {
  root_id: string
  created_at: string
  sender_id: string
  sender_name: string
}

export interface RootReadRow {
  root_message_id: string
  last_read_at: string
}

export interface ThreadMeta {
  reply_count: number
  last_reply_at: string
  last_reply_sender: string
  /** This user has replies in the thread they haven't seen. Driven by the
   *  per-root read pointer ONLY — NOT the channel read pointer — so opening the
   *  channel never silently clears an unopened thread's unread replies. */
  unread: boolean
}

/**
 * @param replyRows  every non-deleted reply in the thread (root_id NOT NULL),
 *                   in ascending created_at order.
 * @param rootReads  the caller's internal_root_reads rows.
 * @param currentUserId  the caller — their own replies never mark a thread unread.
 */
export function computeThreadMeta(
  replyRows: ReplyRow[],
  rootReads: RootReadRow[],
  currentUserId: string,
): Record<string, ThreadMeta> {
  const lastReadByRoot = new Map<string, string>()
  for (const rr of rootReads) lastReadByRoot.set(rr.root_message_id, rr.last_read_at)

  interface Acc { reply_count: number; last_reply_at: string; last_reply_sender: string; last_other_at: string | null }
  const acc = new Map<string, Acc>()
  for (const r of replyRows) {
    const cur: Acc = acc.get(r.root_id) ?? { reply_count: 0, last_reply_at: r.created_at, last_reply_sender: r.sender_name, last_other_at: null }
    cur.reply_count += 1
    // replyRows are ascending, so the last one seen is the newest.
    cur.last_reply_at = r.created_at
    cur.last_reply_sender = r.sender_name
    if (r.sender_id !== currentUserId) cur.last_other_at = r.created_at
    acc.set(r.root_id, cur)
  }

  const out: Record<string, ThreadMeta> = {}
  acc.forEach((a, rootId) => {
    const lastRead = lastReadByRoot.get(rootId)
    const unread = !!a.last_other_at && (!lastRead || a.last_other_at > lastRead)
    out[rootId] = {
      reply_count: a.reply_count,
      last_reply_at: a.last_reply_at,
      last_reply_sender: a.last_reply_sender,
      unread,
    }
  })
  return out
}

/** A thread row as the panel needs it for ordering. */
export interface PanelThread {
  root_id: string
  unread: boolean
  status: 'todo' | 'in_progress' | 'waiting' | 'handled'
  last_reply_at: string | null
}

const PANEL_STATUS_ORDER: Record<PanelThread['status'], number> = {
  in_progress: 0, waiting: 1, todo: 2, handled: 3,
}

/**
 * Order the Threads panel: unread ("New") ALWAYS floats to the top regardless of
 * status — so a Done thread that gets a new reply resurfaces instead of hiding.
 * Then by status (Working → Pending → Open → Done), newest reply first.
 * `hideDone` drops only READ done threads (an unread done thread still shows).
 */
export function sortPanelThreads<T extends PanelThread>(threads: T[], hideDone: boolean): T[] {
  return [...threads]
    .filter(t => !(hideDone && t.status === 'handled' && !t.unread))
    .sort((a, b) => {
      if (a.unread !== b.unread) return a.unread ? -1 : 1
      if (PANEL_STATUS_ORDER[a.status] !== PANEL_STATUS_ORDER[b.status]) return PANEL_STATUS_ORDER[a.status] - PANEL_STATUS_ORDER[b.status]
      return (b.last_reply_at ?? '').localeCompare(a.last_reply_at ?? '')
    })
}
