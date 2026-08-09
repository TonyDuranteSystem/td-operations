/**
 * Who signs the Operating Agreement — and who is a member but does NOT sign.
 *
 * THE RULE (Antonio, 2026-08-09):
 *   - Membership is a legal fact. Portal access is not. A member belongs on the
 *     filing, in the OA roster and in the ownership total whether or not they
 *     can ever log in.
 *   - An INDIVIDUAL member with no email is a member, counted in ownership, on
 *     the filing and in the OA — but NOT in the signing set, and no portal.
 *   - A COMPANY member IS a member AND a signer: it signs through its
 *     representative (representative_name / representative_email).
 *
 * AMENDED THE SAME DAY, AFTER THE FIRST VERSION SHIPPED (Antonio, 2026-08-09):
 *   "A multi-member operating agreement signed by only one owner must never
 *    exist. It is a legal document and it must contain all members. So an
 *    agreement can never be issued with fewer signers than members."
 *
 * So the split below is still the right classification — but a non-signer is no
 * longer something to route around. It is a HARD STOP on issuing the agreement,
 * with the blocking member named, shown to the client and raised to staff. See
 * describeSigningBlock(); both call sites must use it so they cannot drift.
 *
 * Yes, that can leave a client stuck until someone supplies the missing email.
 * Antonio's words: that is the correct failure for a legal document, provided
 * the reason is visible and reaches a human.
 *
 * WHY THE FIRST VERSION WAS WRONG, concretely — it let a two-member company end
 * up with exactly ONE expected signature, and every downstream per-member
 * signing gate keys off "more than one signer". They all switched off together:
 * no personal signing link, the shared access code alone could sign, the
 * submitted signer code was ignored, and the executed agreement recorded the
 * roster's first member as the signer instead of whoever actually signed. Live
 * exposure when caught: Full Throttle Media LLC (two owners, one with no email
 * anywhere, both member rows created in the same millisecond so which name got
 * printed was a tie-break). It had no agreement yet, so nothing was executed
 * wrongly. The gate is repaired independently of this file — but this rule is
 * what stops the state from being reachable at all.
 *
 * WHY THIS FILE EXISTS: the rule was previously "every member must have a
 * contact_id or we refuse to create the OA". That conflated three different
 * things — being a member, being reachable, and being a signer. It made an
 * email-less member block the whole document, and it counted every member as a
 * signer, so one unroutable signature left the OA stuck in progress forever
 * (signed_count could never reach total_signers).
 *
 * Two call sites must agree on this or the OA breaks in a way nobody sees: the
 * portal's OA create route and the automatic welcome-package job. They compute
 * it from here rather than each rolling their own.
 *
 * Verified against production 2026-08-09: of the members carrying no email,
 * seven are companies (each with a representative except one) and three are
 * individuals — so the corporate case is the common one, not the exception.
 *
 * ONE PERSON CAN APPEAR TWICE, IN TWO CAPACITIES, AND THAT IS NOT A DUPLICATE.
 * Azarexa LLC is the live case: Umberto Moretti is the 1% individual member AND
 * the contact behind the 99% corporate member Advertising Apex LLC. Both member
 * rows carry his contact_id. He must sign the agreement twice — once for
 * himself, once for the company — so this function maps rows 1:1 and NEVER
 * dedupes by contact. Anything consuming the result must expect two signature
 * rows for one person (the portal's own signing page had to be fixed for this).
 *
 * Why an individual still needs an email while a company does not: a company's
 * signature is routed to its contact, which carries the address. All three
 * email-less individuals in production have contacts that ALSO have no email
 * (verified 2026-08-09) — so treating them as signers would create a signature
 * nobody can ever be sent, which is the stuck-agreement failure this rule
 * exists to prevent.
 */

export interface SigningSetMemberRow {
  member_type: string | null
  full_name: string | null
  company_name: string | null
  email: string | null
  representative_name?: string | null
  representative_email?: string | null
  contact_id: string | null
}

export interface ResolvedSigner {
  /** Display name on the signature line. For a company member this is the
   * representative (the human who actually signs), not the company. */
  name: string
  email: string | null
  contactId: string | null
  /** Set when this signer signs on behalf of a company member. */
  onBehalfOf?: string
}

export interface ResolvedNonSigner {
  name: string
  /** Plain-English reason, safe to show staff. Says what to change to fix it. */
  reason: string
  /** The same fact in the client's own terms. This one reaches a paying client
   *  on the Generate Documents screen, so it must not read like a stack trace
   *  and must not blame them. */
  clientReason: string
}

export interface SigningSet {
  signers: ResolvedSigner[]
  nonSigners: ResolvedNonSigner[]
}

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * The name to print on a signature line.
 *
 * A company member signs through a named human, so the line reads
 * "Michele Cotti (for Whalecot Consulting LLC)". But when the company has NO
 * representative name on file we fall back to the company's own name — and
 * appending the suffix then printed it twice: "Advertising Apex LLC (for
 * Advertising Apex LLC)". That is on the client's executed Operating
 * Agreement, so it is suppressed when the two are the same.
 *
 * Both writers of oa_signatures use this, so the two cannot drift.
 */
export function signerDisplayName(s: ResolvedSigner): string {
  if (!s.onBehalfOf || s.onBehalfOf === s.name) return s.name
  return `${s.name} (for ${s.onBehalfOf})`
}

/**
 * Split a company's member rows into those who sign the OA and those who are
 * members but cannot sign. Never throws; a row it cannot classify lands in
 * nonSigners with a reason rather than silently disappearing.
 */
export function resolveSigningSet(rows: SigningSetMemberRow[]): SigningSet {
  const signers: ResolvedSigner[] = []
  const nonSigners: ResolvedNonSigner[] = []

  for (const r of rows) {
    const companyName = clean(r.company_name)
    const fullName = clean(r.full_name)

    if (r.member_type === 'company') {
      // A company member signs through its representative — the human acting
      // for it. THE LINKED CONTACT IS THE PRIMARY SOURCE, the representative
      // text fields are only a fallback (Antonio, 2026-08-09). Live proof of
      // why: Advertising Apex LLC (99% of Azarexa) has no representative name
      // or email at all, but its contact_id points at Umberto Moretti — the
      // system does know who signs for it, and keying on the text fields alone
      // would wrongly call it unsignable.
      const repEmail = clean(r.representative_email)
      const repName = clean(r.representative_name)
      const label = companyName ?? fullName ?? 'Unknown company'
      if (r.contact_id || repEmail) {
        signers.push({
          name: repName ?? label,
          email: repEmail,
          contactId: r.contact_id ?? null,
          onBehalfOf: label,
        })
      } else {
        nonSigners.push({
          name: label,
          reason: 'company member with no linked contact and no representative on file — link a contact or add a representative name and email to have it sign',
          clientReason: `${label} is a company, and we do not have the name and email of the person who signs on its behalf.`,
        })
      }
      continue
    }

    // Individual.
    const email = clean(r.email)
    const label = fullName ?? companyName ?? 'Unknown member'
    if (email) {
      signers.push({ name: label, email, contactId: r.contact_id ?? null })
    } else {
      nonSigners.push({
        name: label,
        reason: 'individual member with no email — counted in ownership and named in the agreement, but cannot be sent a signature request',
        clientReason: `We have no email address on file for ${label}.`,
      })
    }
  }

  return { signers, nonSigners }
}

export interface SigningBlock {
  /** True when the agreement must NOT be issued. */
  blocked: boolean
  /** The members standing in the way, in roster order. */
  members: ResolvedNonSigner[]
  /** Shown to the client. Names every blocking member and says what unsticks
   *  it. Empty string when not blocked. */
  clientMessage: string
  /** The same for staff, with the actionable detail. Empty when not blocked. */
  staffMessage: string
}

/**
 * The gate on issuing a multi-member Operating Agreement.
 *
 * An agreement is never issued with fewer signers than members (Antonio,
 * 2026-08-09, amending the rule set earlier the same day). Every member who
 * cannot be sent a signature request blocks it, is named, and the reason is
 * shown to the client AND raised to staff.
 *
 * Deliberately takes the resolved set rather than the raw rows so a caller
 * cannot check the block against one classification and then sign with another.
 *
 * NOTE the empty-roster case: an agreement with no members at all is not this
 * function's business — the callers reject that earlier with their own message,
 * because "nobody can sign" and "there are no members" need different fixes.
 */
export function describeSigningBlock(set: SigningSet): SigningBlock {
  if (set.nonSigners.length === 0) {
    return { blocked: false, members: [], clientMessage: '', staffMessage: '' }
  }

  const names = set.nonSigners.map(n => n.name)
  const nameList =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  const clientMessage = [
    'The Operating Agreement has to be signed by every owner, so we cannot create it yet.',
    set.nonSigners.map(n => n.clientReason).join(' '),
    `Please add contact details for ${nameList} — or send us a message and we will add them for you — then try again.`,
  ].join(' ')

  const staffMessage = `Operating Agreement blocked: ${set.nonSigners
    .map(n => `${n.name} — ${n.reason}`)
    .join('; ')}`

  return { blocked: true, members: set.nonSigners, clientMessage, staffMessage }
}
