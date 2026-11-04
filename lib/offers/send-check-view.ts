/**
 * What the box "Before this offer can be sent" says, as plain code (offer builder Part 1, dev job d2971d11).
 * No fetch, no React: the words and the rules for them are tested in tests/unit/offer-send-check-view.test.ts; the box only draws them.
 *
 * Rules the plan set (Offer Builder Plan v4 + Addendum 1):
 *  - never the word "ready" — "No problems found in what was checked", because the box cannot see everything;
 *  - what could NOT be checked is always listed, so a clean list is never read as "everything is fine";
 *  - a reply that cannot be trusted (expired login, error page) is NOT shown as a result at all;
 *  - risks are warnings that never block; the real Send is the only gate.
 */

export interface SendCheckReadinessItem {
  message: string
  kind?: string
  href?: string
}
export interface SendCheckReplyBlocker {
  step: string
  message: string
  couldNotCheck?: boolean
  readiness?: SendCheckReadinessItem[]
}
export interface SendCheckReply {
  applicable: boolean
  status?: string
  blockers: SendCheckReplyBlocker[]
  risks: string[]
  notChecked: string[]
  willSendTo: string | null
  checkedAt: string | null
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * The reply of GET /api/crm/admin-actions/offer-send-check, or null when it cannot be trusted. null means "show that the check
 * could not be made" — never an empty list that would read as "no problems".
 */
export function parseSendCheckReply(ok: boolean, body: unknown): SendCheckReply | null {
  if (!ok || !body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.applicable === false) {
    return { applicable: false, status: typeof b.status === 'string' ? b.status : undefined, blockers: [], risks: [], notChecked: [], willSendTo: null, checkedAt: typeof b.checkedAt === 'string' ? b.checkedAt : null }
  }
  if (b.applicable !== true) return null
  if (!Array.isArray(b.blockers) || !isStringArray(b.risks) || !isStringArray(b.notChecked)) return null
  const blockers: SendCheckReplyBlocker[] = []
  for (const raw of b.blockers) {
    if (!raw || typeof raw !== 'object') return null
    const x = raw as Record<string, unknown>
    if (typeof x.step !== 'string' || typeof x.message !== 'string') return null
    const readiness = Array.isArray(x.readiness)
      ? (x.readiness as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).message === 'string')
          .map((r) => ({ message: r.message as string, kind: typeof r.kind === 'string' ? r.kind : undefined, href: typeof r.href === 'string' ? r.href : undefined }))
      : undefined
    blockers.push({ step: x.step, message: x.message, couldNotCheck: x.couldNotCheck === true, ...(readiness && readiness.length > 0 ? { readiness } : {}) })
  }
  return {
    applicable: true,
    status: typeof b.status === 'string' ? b.status : undefined,
    blockers,
    risks: b.risks as string[],
    notChecked: b.notChecked as string[],
    willSendTo: typeof b.willSendTo === 'string' && b.willSendTo ? b.willSendTo : null,
    checkedAt: typeof b.checkedAt === 'string' ? b.checkedAt : null,
  }
}

export interface BoxProblem {
  text: string
  /** Where to fix it (a service's page), when the reason belongs to a catalog service. */
  href?: string
  linkLabel?: string
}

export interface BoxModel {
  tone: 'ok' | 'blocked'
  headline: string
  problems: BoxProblem[]
  risks: string[]
  notChecked: string[]
  willSendTo: string | null
  /** One plain sentence for whoever cannot fix a problem themselves; empty when there are no problems. */
  askLine: string
}

export const OK_HEADLINE = 'No problems found in what was checked'
export const BLOCKED_HEADLINE = 'Send will refuse this offer until these are fixed'

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** The rows the box draws for a trusted reply. */
export function boxModel(reply: SendCheckReply): BoxModel {
  const problems: BoxProblem[] = []
  for (const b of reply.blockers) {
    if (b.readiness && b.readiness.length > 0) {
      for (const r of b.readiness) {
        problems.push({ text: sentence(r.message), ...(r.href ? { href: r.href, linkLabel: r.kind === 'contract' ? 'Open contract' : 'Open service' } : {}) })
      }
    } else {
      problems.push({ text: sentence(b.message) })
    }
  }
  const blocked = problems.length > 0
  return {
    tone: blocked ? 'blocked' : 'ok',
    headline: blocked ? BLOCKED_HEADLINE : OK_HEADLINE,
    problems,
    risks: reply.risks,
    notChecked: reply.notChecked,
    willSendTo: reply.willSendTo,
    askLine: blocked ? 'If you cannot fix one of these yourself, ask Antonio.' : '',
  }
}
