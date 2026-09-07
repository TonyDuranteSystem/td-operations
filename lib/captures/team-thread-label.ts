/**
 * A client "discussion" thread's `label` (from GET /api/team/threads) is just
 * the account/contact name — every per-topic discussion about the SAME
 * client (closure, tax, banking...) shares that one label, so a client with
 * several open topics renders as several visually-identical, unpickable rows
 * in the Capture tool's team-chat picker (Antonio, 2026-09-04, "look what a
 * mess" — screenshotted from the real sandbox site, 3 threads all reading
 * "QA Alpha LLC"). `title` already carries the topic ("QA Alpha LLC — tax")
 * for exactly this thread_type.
 *
 * NOT used for every thread_type: a `general`-type thread's `title` is an
 * internal sentinel value (`__team_general__`), never meant to be shown, and
 * channel-type threads' title is already effectively the same as their label.
 */
export interface TeamThreadLabelInput {
  id: string
  label: string
  title?: string | null
  thread_type: string
}

export function teamThreadDisplayLabel(t: TeamThreadLabelInput): string {
  if (t.thread_type === 'discussion' && t.title) return t.title
  return t.label || t.id
}
