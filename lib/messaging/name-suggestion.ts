import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  comparableChatNames,
  isOneToOneNumberKey,
  namesMatchForSuggestion,
  nameTokens,
  phoneSlotPlan,
  suggestionKind,
  type ContactPhoneSlot,
} from "@/lib/messaging/name-match"

export interface NameSuggestionContact {
  id: string
  name: string
  accountName: string | null
  /** The numbers already on file, for display ("is this the same person?"). */
  phones: string[]
  /** False when all four phone slots are taken — the number cannot be added. */
  canAdd: boolean
}

export type NameSuggestion =
  | { kind: "one"; contact: NameSuggestionContact }
  | { kind: "several"; names: string[] }

const CONTACT_COLS = "id, full_name, phone, phone_2, phone_3, phone_4, account_contacts(accounts(company_name))"

type ContactRow = { id: string; full_name: string | null } & Partial<Record<ContactPhoneSlot, string | null>> & { account_contacts?: unknown }

/**
 * An unlinked chat whose sender(s) share a full name with exactly one existing contact → offer that contact.
 * Names come from the chat's saved name and the names its inbound senders use (our own business name, "TD Team" and bare
 * numbers are ignored). Read-only; never links or writes. `chatNumberDigits` is only used to tell "can the number still be added".
 */
const CANDIDATE_LIMIT = 100

export async function findNameSuggestion(groupId: string, externalGroupId: string, groupName: string | null): Promise<NameSuggestion | null> {
  if (!isOneToOneNumberKey(externalGroupId)) return null
  const { data: msgs, error: msgError } = await supabaseAdmin
    .from("messages")
    .select("sender_name")
    .eq("group_id", groupId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(20)
  if (msgError) throw new Error(`sender names: ${msgError.message}`)
  const names = comparableChatNames(groupName, (msgs ?? []).map((m) => m.sender_name), externalGroupId)
  const usable = names.filter((n) => nameTokens(n).length >= 2)
  if (usable.length === 0) return null

  const found = new Map<string, ContactRow>()
  let truncated = false
  for (const name of usable) {
    const longest = nameTokens(name).sort((a, b) => b.length - a.length)[0]
    const { data: rows, error } = await supabaseAdmin
      .from("contacts")
      .select(CONTACT_COLS)
      .is("merged_into", null)
      .or("is_test.is.null,is_test.eq.false")
      .ilike("full_name", `%${longest}%`)
      .limit(CANDIDATE_LIMIT)
    // An errored lookup must never look like "nobody else has this name" — fail closed (the caller shows nothing).
    if (error) throw new Error(`candidate contacts: ${error.message}`)
    if ((rows ?? []).length >= CANDIDATE_LIMIT) truncated = true
    for (const r of (rows ?? []) as unknown as ContactRow[]) {
      if (usable.some((n) => namesMatchForSuggestion(n, r.full_name))) found.set(r.id, r)
    }
  }
  const matches = Array.from(found.values())
  // A cut-off candidate list could hide a second same-name client, so "one" would be a guess: treat it as "several".
  const kind = truncated && matches.length >= 1 ? "several" : suggestionKind(matches)
  if (kind === "none") return null
  if (kind === "several") return { kind: "several", names: matches.slice(0, 4).map((m) => m.full_name ?? "") }
  const c = matches[0]
  const acct = (c.account_contacts as Array<{ accounts?: { company_name?: string | null } | null }> | undefined)?.[0]?.accounts?.company_name ?? null
  const slots: Partial<Record<ContactPhoneSlot, string | null>> = { phone: c.phone, phone_2: c.phone_2, phone_3: c.phone_3, phone_4: c.phone_4 }
  return {
    kind: "one",
    contact: {
      id: c.id,
      name: c.full_name ?? "",
      accountName: acct,
      phones: Object.values(slots).filter((p): p is string => !!p && !!p.trim()),
      canAdd: phoneSlotPlan(slots, externalGroupId).kind !== "full",
    },
  }
}
