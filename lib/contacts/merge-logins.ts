/**
 * Contact merge slice 3 (dev job 938af003): WHAT HAPPENS TO THE PORTAL LOGINS when two contacts are merged.
 *
 * A client login is an auth user tied to ONE contact by `app_metadata.contact_id`. The merge used to delete every login of the
 * removed contact and keep the kept contact's, so a person whose only working login sat on the removed contact was locked out.
 * Now the person who runs the merge chooses, and this file is the pure rule: which choices exist for a pair of contacts, which one
 * is suggested, and which login moves / which are deleted. Nothing here reads or writes (tests cover it); the route applies it
 * (`lib/operations/merge-logins.ts`).
 *
 *  - "kept"    : the kept contact's login stays (the removed contact's login, if any, is deleted) — the old behaviour.
 *  - "removed" : the REMOVED contact's login moves to the kept contact and the kept contact's own login (if any) is deleted.
 *  - "none"    : the removed contact's login is deleted and the kept contact has no login afterwards (only offered when the kept
 *                contact has none — the person will need a new login).
 *
 * A contact is meant to have exactly one login (production: no contact has two). When either side has more than one, only
 * "kept" is offered and nothing about the extra logins changes beyond the old rule — never a guess about which of several to keep.
 */

export type LoginChoice = "kept" | "removed" | "none"

export interface LoginLite { id: string; working: boolean }

export interface LoginChoices {
  /** the choices the screen may offer, in the order shown */
  options: LoginChoice[]
  /** the one that is preselected */
  defaultChoice: LoginChoice
  /** the person must pick (any default could delete the login that is actually in use) */
  mustChoose: boolean
  /** plain-English reason when the screen can only offer the old rule */
  note: string | null
}

export function loginChoices(removed: LoginLite[], kept: LoginLite[]): LoginChoices {
  if (removed.length === 0) return { options: ["kept"], defaultChoice: "kept", mustChoose: false, note: null }
  if (removed.length > 1 || kept.length > 1) {
    return { options: ["kept"], defaultChoice: "kept", mustChoose: false, note: "One of the two contacts has more than one login. They are handled as before: the kept contact's logins stay and the removed contact's are deleted." }
  }
  if (kept.length === 0) {
    const worth = removed[0].working
    return { options: ["removed", "none"], defaultChoice: worth ? "removed" : "none", mustChoose: worth, note: null }
  }
  // exactly one login on each side. "Can sign in" is not proof of use (an unused login usually counts as working too), so there is NO
  // safe default: the person must choose, looking at each login's last sign-in.
  return { options: ["kept", "removed"], defaultChoice: "kept", mustChoose: true, note: null }
}

export type LoginChoiceCheck = { ok: true; choice: LoginChoice } | { ok: false; error: string }

/** The choice the caller sent (or none) checked against the logins of the pair as they are right now. */
export function resolveLoginChoice(sent: unknown, removed: LoginLite[], kept: LoginLite[]): LoginChoiceCheck {
  const c = loginChoices(removed, kept)
  if (sent === undefined || sent === null || sent === "") {
    if (c.mustChoose) return { ok: false, error: "Choose what happens to the removed contact's login (move it to the kept contact, or remove it). Nothing was changed." }
    return { ok: true, choice: c.defaultChoice }
  }
  if (sent !== "kept" && sent !== "removed" && sent !== "none") return { ok: false, error: "That login choice is not valid. Reload the merge window and try again — nothing was changed." }
  if (!c.options.includes(sent)) return { ok: false, error: "That login choice no longer fits these two contacts (their logins changed). Reload the merge window and try again — nothing was changed." }
  return { ok: true, choice: sent }
}

export interface LoginActions {
  /** the login that moves to the kept contact (null = none moves) */
  moveId: string | null
  /** logins deleted AFTER the move (or the merge) succeeded */
  deleteIds: string[]
}

export function loginActions(choice: LoginChoice, removed: LoginLite[], kept: LoginLite[]): LoginActions {
  if (choice === "removed") return { moveId: removed[0]?.id ?? null, deleteIds: kept.map((l) => l.id) }
  // "kept" and "none": the removed contact's logins go, the kept contact's stay
  return { moveId: null, deleteIds: removed.map((l) => l.id) }
}

/** One plain sentence for the merge window / the log: what will happen with the choice made. */
export function describeLoginChoice(choice: LoginChoice, removedEmail: string | null, keptEmail: string | null, keptName: string, removedLoginCount: number, keptLoginCount: number): string {
  if (removedLoginCount === 0 && keptLoginCount === 0) return "Neither contact has a portal login."
  if (removedLoginCount === 0) return `${keptEmail ?? "The kept contact's login"} stays as it is.`
  if (choice === "removed") {
    return keptLoginCount > 0
      ? `${removedEmail ?? "The removed contact's login"} moves to ${keptName} and becomes the login to use. ${keptEmail ?? "The kept contact's own login"} is deleted.`
      : `${removedEmail ?? "The removed contact's login"} moves to ${keptName}. The person keeps the same email and password.`
  }
  if (choice === "none") return `The removed contact's login is deleted. ${keptName} will have no portal login until a new one is created.`
  return keptLoginCount > 0
    ? `${keptEmail ?? "The kept contact's login"} stays. The removed contact's login is deleted.`
    : "The removed contact's login is deleted."
}
