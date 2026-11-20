/**
 * Team Powers step 6 — a team login accepts its own notice (the three logins that were created before notices existed).
 *
 * "Waiting for a notice" is stored in ONE place: `portal_team_members.notice_version IS NULL` on an active login. Every login added
 * since step 4 carries the version the OWNER accepted at the moment of adding, so only the older ones wait.
 *
 * Rules (each has a test):
 *   - Only an ACTIVE team login can accept, and only for itself (the row is found from the signed-in person, never from the request).
 *   - The text and version saved are built HERE, on the server, from the login's real powers and its language. The browser sends
 *     only the version it was shown; if it is not the current one the person is asked to reload, so nobody accepts words they did not see.
 *   - Accepting twice is harmless (the second call changes nothing).
 *   - Two windows at once: the write only succeeds while the version is still empty, so the second one changes nothing.
 *   - No record, no grant: the line of the team record is written strictly; if it cannot be saved the acceptance is undone and the
 *     person stays on the banner.
 *   - Nothing about this ever BLOCKS a switch-off: a switched-off login is not active and cannot accept.
 *
 * Dependencies are passed in so the rules run without a database (tests); login-notice-server.ts wires the real ones.
 */
import { normalizeCapabilities } from './capabilities'
import type { NoticeLang } from './capability-labels'
import { buildTeamLoginNotice, TEAM_LOGIN_NOTICE_VERSION } from './login-notice'
import type { TeamEventInput } from './events'

export interface AcceptRow {
  id: string
  account_id: string
  display_name: string
  status: string
  notice_version: string | null
  capabilities: unknown
  created_at?: string | null
}

export interface AcceptDeps {
  fetchRow: (authUserId: string) => Promise<AcceptRow | null>
  companyName: (accountId: string) => Promise<string>
  /** Saves the acceptance ONLY while notice_version is still empty. Returns true when a row was changed. */
  markAccepted: (teamMemberId: string, patch: { notice_version: string; notice_accepted_at: string; notice_accepted_ip: string | null }) => Promise<boolean>
  /** Puts the row back to "waiting" (used only when the record line could not be saved). */
  unmark: (teamMemberId: string) => Promise<void>
  /** STRICT: throws when the line cannot be saved. */
  recordEvent: (input: TeamEventInput) => Promise<void>
  /** Never throws. */
  recordEventBestEffort: (input: TeamEventInput) => Promise<boolean>
  now?: () => Date
}

export interface AcceptInput {
  authUserId: string
  lang: NoticeLang
  /** The notice version the browser showed. */
  shownVersion: unknown
  ip: string | null
}

export type AcceptResult =
  | { ok: true; alreadyAccepted: boolean }
  | { ok: false; status: number; error: string }

export function isNoticeWaiting(row: { status?: unknown; notice_version?: unknown } | null | undefined): boolean {
  return !!row && row.status === 'active' && row.notice_version === null
}

export async function acceptTeamLoginNotice(input: AcceptInput, deps: AcceptDeps): Promise<AcceptResult> {
  const row = await deps.fetchRow(input.authUserId)
  if (!row || row.status !== 'active' || !row.account_id) {
    return { ok: false, status: 403, error: 'This login has no access.' }
  }
  if (row.notice_version) return { ok: true, alreadyAccepted: true }

  if (input.shownVersion !== TEAM_LOGIN_NOTICE_VERSION) {
    return { ok: false, status: 409, error: 'The notice was updated. Please reload the page and read it again.' }
  }

  const company = await deps.companyName(row.account_id)
  const notice = buildTeamLoginNotice({
    lang: input.lang,
    memberName: row.display_name,
    companyName: company,
    caps: normalizeCapabilities(row.capabilities),
  })

  const when = (deps.now?.() ?? new Date()).toISOString()
  const changed = await deps.markAccepted(row.id, {
    notice_version: notice.version,
    notice_accepted_at: when,
    notice_accepted_ip: input.ip,
  })
  // Someone (this same person in another window) accepted a moment ago: nothing more to do.
  if (!changed) return { ok: true, alreadyAccepted: true }

  try {
    await deps.recordEvent({
      teamMemberId: row.id,
      accountId: row.account_id,
      event: 'notice_accepted',
      actor: { kind: 'system', ip: input.ip },
      detail: {
        accepted_by: 'team_login',
        notice_version: notice.version,
        notice_text: notice.text,
        language: input.lang,
      },
    })
  } catch {
    await deps.unmark(row.id).catch(() => undefined)
    return { ok: false, status: 500, error: 'We could not save the record of this acceptance, so nothing changed. Please try again.' }
  }

  // Informational: this login existed before notices did. Never blocks anything.
  await deps.recordEventBestEffort({
    teamMemberId: row.id,
    accountId: row.account_id,
    event: 'migrated',
    actor: { kind: 'system', ip: input.ip },
    detail: {
      note: 'Login created before team notices existed; its notice was collected from the login itself.',
      created_at: row.created_at ?? null,
    },
  })

  return { ok: true, alreadyAccepted: false }
}
