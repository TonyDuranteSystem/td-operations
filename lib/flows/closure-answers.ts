/**
 * Which closure wizard belongs to THIS Company Closure job — for the "Closure wizard answers" box in the workspace.
 *
 * A wizard row (closure_submissions) has no link to the job, so "the newest finished one for this person/company" can be a DIFFERENT, older
 * closure's answers (a client who closed one LLC and later buys a second closure). Same rule family as lib/portal/pending-closures.ts
 * (isClosureFormSubmitted), which the council fixed on 2026-09-24 to "decline rather than guess":
 *   1. the job remembers the wizard it was created from (source_closure_token) -> that one, or nothing if it is not finished yet;
 *   2. otherwise, ONLY when no other open closure shares the same scope (the company, or the person's no-company closures): the newest finished
 *      wizard that was made on/after the job was created (an older, finished closure of the same person is never picked);
 *   3. otherwise nothing — a blank box is better than another closure's answers.
 * Pure, so the route and the tests use the same rule.
 */

export interface ClosureAnswerRow {
  token: string | null
  status: string | null
  created_at: string
  completed_at?: string | null
}

export interface ClosureJobForAnswers {
  id: string
  created_at: string
  source_closure_token: string | null
}

export interface OtherClosureJob {
  id: string
}

const FINISHED = new Set(['completed', 'reviewed'])

function lastTouched(r: ClosureAnswerRow): number {
  const times = [r.created_at, r.completed_at]
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
  return times.length > 0 ? Math.max(...times) : NaN
}

/** `rows` are the wizards of this job's scope (the company's, or the person's no-company ones); `otherOpenJobs` are the OTHER open closures in that same scope. */
export function pickClosureAnswers<T extends ClosureAnswerRow>(p: {
  job: ClosureJobForAnswers
  rows: T[]
  otherOpenJobs: OtherClosureJob[]
}): T | null {
  const finished = p.rows.filter((r) => FINISHED.has(r.status ?? ''))

  if (p.job.source_closure_token) {
    return finished.find((r) => r.token === p.job.source_closure_token) ?? null
  }

  if (p.otherOpenJobs.length > 0) return null

  const jobStart = new Date(p.job.created_at).getTime()
  if (!Number.isFinite(jobStart)) return null
  const candidates = finished
    .filter((r) => lastTouched(r) >= jobStart)
    .sort((a, b) => lastTouched(b) - lastTouched(a))
  return candidates[0] ?? null
}
