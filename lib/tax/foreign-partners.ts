/**
 * "Does this LLC have any foreign partners?" — DERIVED from the member cards,
 * never asked as a standalone yes/no.
 *
 * WHY IT IS NOT A QUESTION ANY MORE
 * It used to be one ("Any foreign partners?", optional, no explanation). On
 * production, of 15 submitted multi-member tax forms: 2 answered Yes, 6
 * answered No while every listed member was non-US, and 7 left it blank. One
 * usable answer in six. The clients were not being careless — they had just
 * typed each member's citizenship, residence and entity country a step earlier,
 * and were then asked to summarise it in tax vocabulary ("partner" means
 * "member"; IRC §761(b)) that nobody outside the profession uses.
 *
 * So we compute it from what they already told us, and show them the result to
 * confirm. Their member answers remain the client statement behind it.
 *
 * THE RULE (IRC §7701(a)(30) — "US person"; §7701(b)(1)(A) — resident alien)
 *   A PERSON is foreign unless any of these is true:
 *     · they are a US citizen, or
 *     · they hold a US green card (lawful permanent resident), or
 *     · they live in the US (proxy for the substantial-presence test).
 *   A COMPANY is foreign if it was not formed under US law. Place of formation
 *   decides — a US-formed entity is a US person EVEN IF foreigners own it.
 *
 * WHAT THIS DRIVES: Form 1065 Schedule B line 14, Schedule B-1 disclosure, and
 * Schedules K-2/K-3 (a single foreign partner breaks the domestic filing
 * exception). It does NOT by itself create US tax — §1446 withholding needs
 * effectively connected income.
 *
 * DELIBERATE LIMIT: the green-card answer is the one fact citizenship and
 * residence cannot supply, which is why it is collected per member. A member
 * whose data is incomplete is reported as `unknown`, never silently assumed
 * domestic — the caller must resolve it rather than file a guess.
 */

/** Country strings arrive free-text from a country picker and from legacy rows:
 *  "USA", "United States", "Stati Uniti", "US", and (seen in production) the
 *  state "Florida". Normalise generously — a false "not US" would wrongly flag
 *  a domestic member as foreign. */
const US_COUNTRY_ALIASES = new Set([
  'us', 'usa', 'u s', 'u s a', 'united states', 'united states of america',
  'stati uniti', "stati uniti d'america", 'estados unidos', 'états-unis', 'etats-unis',
  'america',
])

/** US states/territories sometimes typed into a country box (production data). */
const US_STATE_ALIASES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia', 'puerto rico',
])

function normalizeCountry(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
}

/** True when the country string names the United States (or a US state). */
export function isUsCountry(raw: string | null | undefined): boolean {
  const n = normalizeCountry(raw)
  if (!n) return false
  return US_COUNTRY_ALIASES.has(n) || US_STATE_ALIASES.has(n)
}

export type MemberKind = 'individual' | 'company'

export interface MemberForeignInput {
  /** For messages back to the client — which member this is. */
  name?: string | null
  kind: MemberKind
  /** Individual: country of citizenship. */
  citizenship?: string | null
  /** Individual: country the member physically lives in. */
  residenceCountry?: string | null
  /** Individual: holds a US green card (lawful permanent resident). */
  greenCard?: boolean | null
  /** Company: country the entity was FORMED in (not where it trades). */
  companyCountry?: string | null
}

export type MemberStatus = 'foreign' | 'us' | 'unknown'

export interface MemberVerdict {
  name: string | null
  status: MemberStatus
  /** Plain-English reason, safe to show a client. */
  reason: string
}

/** Classify ONE member. Never guesses: missing data ⇒ 'unknown'. */
export function classifyMember(m: MemberForeignInput): MemberVerdict {
  const name = m.name?.trim() || null

  if (m.kind === 'company') {
    if (!normalizeCountry(m.companyCountry)) {
      return { name, status: 'unknown', reason: 'We do not know which country this company was formed in.' }
    }
    return isUsCountry(m.companyCountry)
      ? { name, status: 'us', reason: 'A company formed in the United States counts as American, whoever owns it.' }
      : { name, status: 'foreign', reason: 'This company was formed outside the United States.' }
  }

  // ── Individual ──
  if (m.greenCard === true) {
    return { name, status: 'us', reason: 'Holds a US green card, so counts as American for tax.' }
  }
  if (isUsCountry(m.citizenship)) {
    return { name, status: 'us', reason: 'Is a US citizen.' }
  }
  if (isUsCountry(m.residenceCountry)) {
    return { name, status: 'us', reason: 'Lives in the United States, so counts as American for tax.' }
  }
  // Only now can we say foreign — and only if we actually HAVE the facts.
  const missing: string[] = []
  if (!normalizeCountry(m.citizenship)) missing.push('country of citizenship')
  if (!normalizeCountry(m.residenceCountry)) missing.push('country they live in')
  if (m.greenCard === null || m.greenCard === undefined) missing.push('whether they hold a US green card')
  if (missing.length > 0) {
    return { name, status: 'unknown', reason: `We still need: ${missing.join(', ')}.` }
  }
  return { name, status: 'foreign', reason: 'Not a US citizen, does not live in the US, and holds no green card.' }
}

export interface ForeignPartnerResult {
  /** true / false once every member is resolved; null while any is unknown. */
  hasForeignPartners: boolean | null
  perMember: MemberVerdict[]
  foreignNames: string[]
  /** Members we could not classify — the caller must resolve these. */
  unresolvedNames: string[]
  /** One sentence to show the client for confirmation. */
  summary: string
}

/**
 * Decide the Schedule B line 14 answer for a whole LLC.
 * A single foreign member makes it Yes, so an unknown member only blocks the
 * answer when no member is already known to be foreign.
 */
export function deriveForeignPartners(members: MemberForeignInput[]): ForeignPartnerResult {
  const perMember = members.map(classifyMember)
  const foreignNames = perMember.filter(v => v.status === 'foreign').map(v => v.name ?? 'a member')
  const unresolvedNames = perMember.filter(v => v.status === 'unknown').map(v => v.name ?? 'a member')

  if (members.length === 0) {
    return { hasForeignPartners: null, perMember, foreignNames, unresolvedNames, summary: 'No members recorded yet.' }
  }

  // One confirmed foreign member settles it, even if others are incomplete.
  if (foreignNames.length > 0) {
    return {
      hasForeignPartners: true,
      perMember,
      foreignNames,
      unresolvedNames,
      summary: foreignNames.length === 1
        ? `${foreignNames[0]} is a foreign member, so the LLC has foreign partners.`
        : `${foreignNames.join(', ')} are foreign members, so the LLC has foreign partners.`,
    }
  }

  if (unresolvedNames.length > 0) {
    return {
      hasForeignPartners: null,
      perMember,
      foreignNames,
      unresolvedNames,
      summary: `We cannot tell yet — some details are missing for ${unresolvedNames.join(', ')}.`,
    }
  }

  return {
    hasForeignPartners: false,
    perMember,
    foreignNames,
    unresolvedNames,
    summary: 'Every member counts as American for tax purposes, so the LLC has no foreign partners.',
  }
}
