/**
 * The ONE rule for a contact id that arrives from the CALLER of the portal chat route (the query string of the read, the body of the send).
 *
 *   - staff (not a client login)                 → any id, as before (the dashboard reads and answers any person's thread)
 *   - a client with a person behind the login    → only their OWN contact id (or none)
 *   - a team login (a client login, no person)   → never a contact id (it reads and writes its one company only)
 *
 * Before this rule the read checked a client's contact id only when NO company was named, so a client — or a team login with the Chat
 * tick — that named its own company and ANOTHER person's contact id got that person's whole message history (every company, and the
 * private thread); the send stored a message under another person's contact id the same way. The ids are easy to find: every message
 * in a company thread carries its sender's contact id. The sibling routes (read, upload-url, convert-attachment, notifications) already
 * apply this rule; this puts the chat read and send on it too.
 *
 * PURE — no database. Fails closed: a client login that is neither a person nor a named team login never matches an id.
 */
export function callerContactIdAllowed(i: {
  /** The login's app role is "client" (a person OR a team login). False = staff. */
  isClientUser: boolean
  /** The contact id behind the login (null for a team login). */
  authContactId: string | null
  /** The contact id the caller put in the request, if any. */
  callerContactId: string | null | undefined
}): boolean {
  if (!i.isClientUser) return true
  if (!i.callerContactId) return true
  if (!i.authContactId) return false
  return i.callerContactId === i.authContactId
}
