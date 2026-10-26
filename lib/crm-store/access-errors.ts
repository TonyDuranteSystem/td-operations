/**
 * The access check before a storage route (denyUnlessAreaAccess) can fail in two very different ways, and the page treats them
 * differently: "Not found" (404) means the folder / file / area is really gone or private → the page leaves it; a database hiccup
 * is NOT that → 503, and the page keeps the user where they are and retries quietly. PURE.
 */
export const TRANSIENT_ACCESS_MESSAGE = "Could not check access — please try again."

/** 404 only when the error says the thing is not found / not visible to this login; anything else (a failed read, an unknown error) is a temporary 503. */
export function accessErrorStatus(e: unknown): 404 | 503 {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : ""
  return /not found/i.test(message) ? 404 : 503
}

/** The words for the answer: the error's own message, or a plain fallback for the status. */
export function accessErrorMessage(e: unknown): string {
  const status = accessErrorStatus(e)
  if (e instanceof Error && e.message) return status === 503 && !/try again/i.test(e.message) ? TRANSIENT_ACCESS_MESSAGE : e.message
  return status === 404 ? "Not found." : TRANSIENT_ACCESS_MESSAGE
}
