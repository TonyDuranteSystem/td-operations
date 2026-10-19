/** Small pure helpers for showing a lead (client-safe; TD Marketing, dev job 9aec66fa). */
export interface StageOption { key: string; label: string }

/** The label of a pipeline stage; an unknown key is shown as itself so a lead is never displayed blank. */
export function stageLabel(stages: readonly StageOption[], key: string | null | undefined): string {
  if (!key) return "—"
  return stages.find(s => s.key === key)?.label ?? key
}

/** "hai_una_attività" -> "Hai una attività": Meta form question keys read as plain text. */
export function prettyQuestion(name: string): string {
  const s = name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name
}

/** "19 Oct 2026, 10:15" in a fixed zone so every viewer sees the same time for the same lead. */
export function formatWhen(iso: string | null | undefined, timeZone = "Europe/Rome"): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone, hour12: false }).format(d)
}

export interface ExistingClientFlag { contact_ids?: string[]; matched_on?: string[]; check_failed?: boolean }

/** A short plain-English note when the lead looks like (or may be) an existing TD client; null when nothing to say. */
export function clientFlagText(flag: ExistingClientFlag | null | undefined): string | null {
  if (!flag) return null
  if (flag.check_failed) return "We could not check whether this person is already a TD client. Ask before selling."
  if (flag.contact_ids?.length) {
    const how = (flag.matched_on ?? []).map(m => (m === "email" ? "email" : m === "phone" ? "phone number" : m)).join(" and ")
    return `Looks like an existing TD client (same ${how || "details"}). Do not cold-sell; check with Antonio first.`
  }
  return null
}

/** Digits-only phone for a tel: link. */
export function telHref(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/[^\d+]/g, "")
  return d.replace(/\D/g, "").length >= 6 ? `tel:${d}` : null
}
