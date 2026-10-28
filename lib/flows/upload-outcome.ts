/**
 * What a workspace document upload shows staff afterwards: a green "done" line, or an AMBER warning when the file is saved but the follow-on
 * step did not (fully) finish. Pure, so the rule is unit-tested — the page (components/flows/document-upload.tsx) only renders it.
 *
 * Amber, never green, when: the company record was not created (Formation Articles), the flow refused to advance (Formation Articles), the
 * principal-address answer needs attention (State Annual Report), or the ITIN letter was saved but reading the number / closing the case /
 * telling the client did not finish (a case that looks closed but is not — the Adam Mihaly class of mistake).
 */
export interface UploadResponseShape {
  detail?: unknown
  advance?: { success?: boolean; error?: string; materialization?: { error?: string } } | null
  itin_finalize?: { warnings?: unknown; finalized?: unknown } | null
  principal_office_warning?: unknown
}

export function uploadOutcome(
  data: UploadResponseShape,
  opts: { fileName: string; needsFormationDate: boolean },
): { warn: string | null; done: string | null } {
  const { fileName, needsFormationDate } = opts
  let warn: string | null = null

  const matError = data.advance?.materialization?.error
  const advanceRefused = needsFormationDate && !!data.advance && data.advance.success === false && !!data.advance.error
  if (matError) warn = `${fileName} uploaded, but the company record was NOT created: ${matError}`
  else if (advanceRefused) warn = `${fileName} uploaded, but the flow did not advance: ${data.advance?.error}`

  if (typeof data.principal_office_warning === 'string' && data.principal_office_warning) warn = data.principal_office_warning

  const finalizeWarnings = Array.isArray(data.itin_finalize?.warnings)
    ? (data.itin_finalize?.warnings as unknown[]).filter((w): w is string => typeof w === 'string' && w.length > 0)
    : []
  if (finalizeWarnings.length > 0) {
    // keep the good news visible: when the ITIN was saved and the case closed, say so — staff must not re-upload for nothing
    const lead = data.itin_finalize?.finalized === true ? `${fileName} uploaded, the ITIN was saved and the case closed, but:` : `${fileName} uploaded, but:`
    warn = `${lead} ${finalizeWarnings.join(' ')}`
  }

  const done = !matError && !advanceRefused && finalizeWarnings.length === 0
    ? (typeof data.detail === 'string' && data.detail ? data.detail : `${fileName} uploaded`)
    : null
  return { warn, done }
}

/**
 * Did the portal chat message to the client really go out? (the ITIN-ready notice, lib/itin/finalize-approval.ts → notifyClientActionRequired).
 * 'ok' = posted. 'skipped: duplicate within dedup window' = an identical message was sent moments ago, so the client HAS it. Anything else
 * (failed, other skip, no result at all) is NOT confirmed — staff must tell the client themselves.
 */
export function clientWasTold(notify: { chat?: unknown } | null | undefined): boolean {
  const chat = notify?.chat
  return typeof chat === 'string' && (chat === 'ok' || chat.startsWith('skipped: duplicate'))
}
