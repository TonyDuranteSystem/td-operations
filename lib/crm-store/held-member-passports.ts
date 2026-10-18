/**
 * CRM Store — member passports that are HELD for the member's own storage (Stop-Drive S1a round 4).
 *
 * Rule (Antonio): a person's passport never lands in another person's storage — not the primary contact's, not the owner's, not a
 * company folder. An LLC form (formation or onboarding) carries one passport per individual member (`passport_member_<N>` /
 * `member_<N>_member_passport`). Those files are NOT filed under the primary contact; they stay on the submission (upload bucket)
 * until THAT member has a contact. Two places file them:
 *   - formation-materialize, when it creates/links the member's contact (existing pilot step, `pilotSavePassport`);
 *   - `fileHeldMemberPassportsForContact` (this file), called whenever a member's contact is created or matched (member-info
 *     form, onboarding setup): it finds the held passport of THAT member in the recent submissions and files it in the member's own
 *     storage. Both use the same caller key (`person-passport:<contact>`), so the file exists once.
 * A member with NO email cannot be matched to a contact automatically: `heldMembersWithoutEmail` tells the lead step to raise ONE alarm
 * so staff create the contact (and this hand-off then runs).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

const MEMBER_PASSPORT_RE = /passport_member_(\d+)|member_(\d+)_member_passport/

/** The member number of a member-passport upload path (null for any other path). */
export function memberIndexOfUpload(path: string): number | null {
  const m = MEMBER_PASSPORT_RE.exec(path)
  if (!m) return null
  return Number(m[1] ?? m[2])
}

export interface HeldMember { index: number; name: string; email: string | null; path: string }

type MemberRow = Record<string, unknown>

const clean = (v: unknown) => String(v ?? "").trim()

/** Pure: the members that have an individual passport upload waiting, from a submission's data + upload paths. */
export function heldMembersOf(submittedData: Record<string, unknown>, uploadPaths: string[]): HeldMember[] {
  const members = Array.isArray(submittedData.additional_members) ? (submittedData.additional_members as MemberRow[]) : []
  const out: HeldMember[] = []
  for (const path of uploadPaths) {
    const idx = memberIndexOfUpload(path)
    if (idx === null) continue
    const m = members[idx]
    if (!m || m.member_type === "company") continue
    out.push({ index: idx, name: `${clean(m.member_first_name)} ${clean(m.member_last_name)}`.trim(), email: clean(m.member_email).toLowerCase() || null, path })
  }
  return out
}

/** Members whose held passport can NOT be matched to a contact automatically (no email on the form). */
export function heldMembersWithoutEmail(held: HeldMember[]): HeldMember[] {
  return held.filter((h) => !h.email)
}

export interface HandOffDeps {
  contact: (id: string) => Promise<{ full_name: string | null; email: string | null } | null>
  recentSubmissions: () => Promise<Array<{ submitted_data: Record<string, unknown> | null; upload_paths: unknown }>>
  namesMatch: (a: string | null, b: string | null) => boolean
  download: (path: string) => Promise<{ bytes: Buffer; mimeType: string | null } | null>
  save: (p: { contactId: string; personName: string; fileName: string; bytes: Buffer; mimeType: string | null }) => Promise<{ status: string }>
}

async function defaultDeps(): Promise<HandOffDeps> {
  const { namesMatch } = await import("./lead-form-store")
  const { pilotSavePassport } = await import("./formation-pilot")
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString()
  return {
    contact: async (id) => {
      const { data } = await supabaseAdmin.from("contacts").select("full_name, email").eq("id", id).maybeSingle()
      return data ? { full_name: (data.full_name as string | null) ?? null, email: (data.email as string | null) ?? null } : null
    },
    recentSubmissions: async () => {
      const out: Array<{ submitted_data: Record<string, unknown> | null; upload_paths: unknown }> = []
      for (const table of ["formation_submissions", "onboarding_submissions"] as const) {
        const { data } = await supabaseAdmin.from(table).select("submitted_data, upload_paths").in("status", ["completed", "reviewed"]).gte("created_at", since).order("created_at", { ascending: false }).limit(100)
        for (const r of data ?? []) out.push({ submitted_data: (r.submitted_data ?? null) as Record<string, unknown> | null, upload_paths: r.upload_paths })
      }
      return out
    },
    namesMatch: (a, b) => namesMatch(a, b),
    download: async (path) => {
      const { data, error } = await supabaseAdmin.storage.from("onboarding-uploads").download(path)
      if (error || !data) return null
      return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: data.type || null }
    },
    save: async (p) => {
      const r = await pilotSavePassport({
        contactId: p.contactId, personName: p.personName, fileName: p.fileName, bytes: p.bytes, mimeType: p.mimeType,
        row: { document_type_name: "Passport", category: 2, category_name: "Contacts", contact_id: p.contactId, portal_visible: true },
      })
      return { status: r.status }
    },
  }
}

/**
 * File the held passport of THIS member (matched by exact email AND name) in their own storage. Idempotent, best-effort: it never
 * throws and never files a passport it cannot attribute with certainty. Returns how many passports it filed.
 */
export async function fileHeldMemberPassportsForContact(contactId: string, deps?: HandOffDeps): Promise<number> {
  try {
    const d = deps ?? (await defaultDeps())
    const c = await d.contact(contactId)
    const email = clean(c?.email).toLowerCase()
    if (!c || !email) return 0
    let filed = 0
    const seen = new Set<string>()
    for (const sub of await d.recentSubmissions()) {
      const paths = Array.isArray(sub.upload_paths) ? (sub.upload_paths as unknown[]).filter((p): p is string => typeof p === "string") : []
      for (const h of heldMembersOf(sub.submitted_data ?? {}, paths)) {
        if (h.email !== email || !d.namesMatch(h.name, c.full_name) || seen.has(h.path)) continue
        seen.add(h.path)
        const file = await d.download(h.path.replace(/^\/+/, ""))
        if (!file) continue
        const res = await d.save({ contactId, personName: c.full_name || h.name || "Member", fileName: h.path.split("/").pop() || "passport.pdf", bytes: file.bytes, mimeType: file.mimeType })
        if (res.status === "saved") filed++
        break // one passport per person
      }
      if (filed > 0) break
    }
    return filed
  } catch {
    return 0
  }
}
