/**
 * What staff are told when the answer to "send this fax" is not a normal answer (bug-hunter round 4).
 * A platform 502/504 page, a function killed at its time limit, or a dropped connection arrive AFTER the request may already have reached
 * Faxage: the outcome is UNKNOWN, and "please try again" would be the wrong advice. Pure: the screens call it with what they saw.
 */
export const FAX_OUTCOME_UNKNOWN_SENTENCE =
  'The answer did not arrive, so it is NOT known whether the fax went out. Do NOT send it again yet: check Fax History and Faxage first.'

/** The sentence for a failed send. `json` = the parsed body or null when the body was not JSON; `networkError` = the request itself failed. */
export function faxSendFailureText(a: { status?: number; json?: { error?: unknown } | null; networkError?: boolean }, fallback = 'Could not send the fax. Please try again.'): string {
  if (a.networkError) return FAX_OUTCOME_UNKNOWN_SENTENCE
  const own = a.json && typeof a.json.error === 'string' && a.json.error.trim() ? a.json.error : null
  // an answer that is not JSON at all (a 2xx / 3xx page from a proxy, a login redirect) is not OUR answer either: the request may have been served
  if (a.json === null && (a.status ?? 0) >= 200 && (a.status ?? 0) < 400) return FAX_OUTCOME_UNKNOWN_SENTENCE
  // our own routes always answer JSON with an `error`: a 5xx WITHOUT one came from the platform (gateway page, killed function)
  if (!own && (a.status ?? 0) >= 500) return FAX_OUTCOME_UNKNOWN_SENTENCE
  return own ?? fallback
}
