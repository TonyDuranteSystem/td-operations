/**
 * VERIFIED CLIENT CARD for the Portal-Chats Worker tab.
 *
 * Council decision (Adam Marra incident, 2026-07-17): the per-client worker
 * used to start every conversation knowing ONLY the client's display name, so
 * every business fact (language, which address is the registered agent vs the
 * CMRA/office, lease state) was a lookup the model could skip or misread —
 * that vacuum produced a wrong-address answer with a fabricated justification.
 *
 * This module builds a server-authored fact card that is:
 * - injected as a PER-CALL system-prompt suffix (buildClientRecallSuffix
 *   pattern) — NEVER persisted into agent_messages, so a stale card can never
 *   replay from thread history and contradict a fresh one;
 * - derived from the VALIDATED clientKey (same source of truth as the
 *   recipient pin), never from optional client-supplied body ids;
 * - rendered from the account's own columns — "not on file" when null, never
 *   a hardcoded assumption (labels must be right for non-WY accounts too);
 * - sanitized: client-typed values are length-capped and newline-stripped
 *   (labels are server-authored; values must not be able to inject rules).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { formatAddressString, type MailingAddressRow } from "@/lib/addresses"

/** Cap + flatten a client-typed value so it can't inject structure or rules. */
export function sanitizeCardValue(v: string | null | undefined, max = 140): string | null {
  if (typeof v !== "string") return null
  const flat = v.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const NOT_ON_FILE = "not on file"

interface CardData {
  companyName: string | null
  entityType: string | null
  stateOfFormation: string | null
  accountStatus: string | null
  registeredAgentAddress: string | null
  registeredAgentProvider: string | null
  mailingAddress: string | null
  contactName: string | null
  contactLanguage: string | null
  contactEmail: string | null
  contactAddress: string | null
  services: Array<{ name: string; stage: string | null; status: string | null }>
  lease: {
    createdAt: string | null
    status: string | null
    suite: string | null
    premises: string | null
    pdfGenerated: boolean
    signedAt: string | null
    pageLanguage: string | null
  } | null
}

/**
 * Render the card text. Pure and exported for unit tests — all DB access lives
 * in buildClientCardSuffix.
 */
export function renderClientCard(d: CardData): string {
  const line = (label: string, v: string | null) => `- ${label}: ${v ?? NOT_ON_FILE}`
  const contactBits = [
    d.contactName ?? NOT_ON_FILE,
    `language on file: ${d.contactLanguage ?? NOT_ON_FILE}`,
    `email: ${d.contactEmail ?? NOT_ON_FILE}`,
  ].join(" — ")
  const services = d.services.length
    ? d.services
        .map((s) => `${s.name}${s.stage ? ` (stage: ${s.stage})` : ""}${s.status ? ` [${s.status}]` : ""}`)
        .join("; ")
    : "none on file"
  const lease = d.lease
    ? [
        `created ${d.lease.createdAt ?? "?"}`,
        `status ${d.lease.status ?? "?"}`,
        `suite ${d.lease.suite ?? NOT_ON_FILE}`,
        `premises ${d.lease.premises ?? NOT_ON_FILE}`,
        d.lease.pdfGenerated ? "PDF generated" : "PDF NOT generated yet",
        d.lease.signedAt ? `signed ${d.lease.signedAt}` : "not signed",
      ].join(", ")
    : "no lease on file"

  return `

━━━ VERIFIED CLIENT CARD (server-built from the live CRM for THIS turn — it supersedes any client facts in earlier conversation turns; trust it over memory) ━━━
Company: ${d.companyName ?? NOT_ON_FILE}${d.entityType ? ` (${d.entityType}` + (d.stateOfFormation ? `, ${d.stateOfFormation}` : "") + ")" : ""}${d.accountStatus ? ` — status: ${d.accountStatus}` : ""}
Primary contact: ${contactBits}
ADDRESSES — these are DIFFERENT things and NEVER interchangeable:
${line("Registered Agent address (state service-of-process ONLY — never a business, mailing, or bank/broker address)", d.registeredAgentAddress && d.registeredAgentProvider ? `${d.registeredAgentAddress} (provider: ${d.registeredAgentProvider})` : d.registeredAgentAddress)}
${line("Business mailing address (CMRA / TD office — the one clients use with banks and brokers, with their lease suite)", d.mailingAddress)}
${line("Client residential address (CRM record — flag it if another source shows a different one)", d.contactAddress)}
Active services: ${services}
Lease: ${lease}
NOTE: a lease record's "language" field is the signing PAGE's display language, NOT the language of the document text — never report it as the document's language.
(If a field says "${NOT_ON_FILE}", say so plainly — do not guess a value.)`
}

/**
 * Build the card for a validated portal-chats clientKey
 * ('acct-<uuid>' | 'contact-<uuid>'). Best-effort: any error returns "" so a
 * card failure never blocks the worker reply (same contract as the recall
 * suffixes).
 */
/**
 * Split a client key into (kind, id), accepting BOTH conventions in use:
 * "acct-<id>" / "contact-<id>" (Inbox, Portal Chats) and "account:<id>" /
 * "contact:<id>" (dashboard sidebar, client-scope). Returns null for anything else —
 * an unrecognised key must yield NO card rather than a wrong or empty one.
 *
 * Exported so the mismatch that caused the empty-card bug is directly testable.
 */
export function parseClientKey(clientKey: string): { isAccount: boolean; id: string } | null {
  const k = (clientKey ?? "").trim()
  const forms: Array<[string, boolean]> = [
    ["acct-", true],
    ["account:", true],
    ["contact-", false],
    ["contact:", false],
  ]
  for (const [prefix, isAccount] of forms) {
    if (k.startsWith(prefix)) {
      const id = k.slice(prefix.length)
      return id ? { isAccount, id } : null
    }
  }
  return null
}

export async function buildClientCardSuffix(clientKey: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any

    // TWO KEY FORMATS EXIST IN THIS SYSTEM and both reach here:
    //   "acct-<id>" / "contact-<id>"    — the Inbox & Portal Chats panels
    //   "account:<id>" / "contact:<id>" — the dashboard sidebar (sidebar-scope.ts),
    //                                     the same shape client-scope.ts uses
    // Parsing only the first silently produced a garbage id from the second (slicing
    // "contact-".length off "account:<uuid>" yields "t:<uuid>"), which then matched no
    // row and returned an EMPTY card — so the assistant sat on a client's page insisting
    // no client was loaded, while holding a send rail pinned to that very client.
    // Accept both rather than making every caller remember which one this wants.
    const parsed = parseClientKey(clientKey)
    if (!parsed) return ""
    const { isAccount, id } = parsed

    const accountId: string | null = isAccount ? id : null
    let contactId: string | null = isAccount ? null : id

    const d: CardData = {
      companyName: null,
      entityType: null,
      stateOfFormation: null,
      accountStatus: null,
      registeredAgentAddress: null,
      registeredAgentProvider: null,
      mailingAddress: null,
      contactName: null,
      contactLanguage: null,
      contactEmail: null,
      contactAddress: null,
      services: [],
      lease: null,
    }

    if (accountId) {
      const { data: acct } = await db
        .from("accounts")
        .select(
          "company_name, entity_type, state_of_formation, status, registered_agent_address, registered_agent_provider, physical_address, business_mailing_address_id"
        )
        .eq("id", accountId)
        .maybeSingle()
      if (!acct) return ""
      d.companyName = sanitizeCardValue(acct.company_name)
      d.entityType = sanitizeCardValue(acct.entity_type)
      d.stateOfFormation = sanitizeCardValue(acct.state_of_formation)
      d.accountStatus = sanitizeCardValue(acct.status)
      d.registeredAgentAddress = sanitizeCardValue(acct.registered_agent_address)
      d.registeredAgentProvider = sanitizeCardValue(acct.registered_agent_provider)
      // Prefer the structured, labeled addresses row; fall back to the legacy
      // free-text physical_address column.
      if (acct.business_mailing_address_id) {
        const { data: addr } = await db
          .from("addresses")
          .select("address_line1, address_line2, city, state, zip")
          .eq("id", acct.business_mailing_address_id)
          .maybeSingle()
        d.mailingAddress = sanitizeCardValue(formatAddressString((addr ?? null) as MailingAddressRow | null))
      }
      if (!d.mailingAddress) d.mailingAddress = sanitizeCardValue(acct.physical_address)

      if (!contactId) {
        const { data: link } = await db
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", accountId)
          .limit(1)
          .maybeSingle()
        contactId = link?.contact_id ?? null
      }
    }

    if (contactId) {
      const { data: c } = await db
        .from("contacts")
        .select("full_name, language, email, address_line1, address_city, address_state, address_zip, address_country")
        .eq("id", contactId)
        .maybeSingle()
      if (c) {
        d.contactName = sanitizeCardValue(c.full_name)
        d.contactLanguage = sanitizeCardValue(c.language)
        d.contactEmail = sanitizeCardValue(c.email)
        const addr = [c.address_line1, c.address_city, c.address_state, c.address_zip, c.address_country]
          .map((x: string | null) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean)
          .join(", ")
        d.contactAddress = sanitizeCardValue(addr)
      }
    }

    if (accountId) {
      const { data: sds } = await db
        .from("service_deliveries")
        .select("service_name, stage, status")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(8)
      d.services = (sds ?? []).map((s: { service_name: string; stage: string | null; status: string | null }) => ({
        name: sanitizeCardValue(s.service_name, 60) ?? "?",
        stage: sanitizeCardValue(s.stage, 40),
        status: sanitizeCardValue(s.status, 30),
      }))

      const { data: lease } = await db
        .from("lease_agreements")
        .select("created_at, status, suite_number, premises_address, pdf_storage_path, signed_at, language")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (lease) {
        d.lease = {
          createdAt: lease.created_at ? String(lease.created_at).slice(0, 10) : null,
          status: sanitizeCardValue(lease.status, 30),
          suite: sanitizeCardValue(lease.suite_number, 30),
          premises: sanitizeCardValue(lease.premises_address),
          pdfGenerated: !!lease.pdf_storage_path,
          signedAt: lease.signed_at ? String(lease.signed_at).slice(0, 10) : null,
          pageLanguage: sanitizeCardValue(lease.language, 10),
        }
      }
    }

    return renderClientCard(d)
  } catch (err) {
    console.warn("[client-card] build failed (worker answers without card):", err)
    return ""
  }
}
