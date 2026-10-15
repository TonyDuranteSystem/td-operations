/**
 * New Calendar — the morning line ("Good morning, Luca — 3 jobs to work on today"). PURE, no clock of its own.
 */

/** A first name for the greeting: the login's full name if it has one, else the part of the email before the first dot/dash. */
export function firstNameOf(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined): string {
  if (!user) return ""
  const meta = user.user_metadata ?? {}
  for (const key of ["full_name", "name"]) {
    const v = meta[key]
    if (typeof v === "string" && v.trim() !== "") return v.trim().split(/\s+/)[0]
  }
  const local = (user.email ?? "").split("@")[0] ?? ""
  const token = local.split(/[._\-+]/)[0] ?? ""
  if (!/^[A-Za-z][A-Za-z']*$/.test(token)) return ""
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

/** "Good morning" / "Good afternoon" / "Good evening" by the hour in New York (the office clock). */
export function greetingWord(now: Date): string {
  const hour = Number.parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" }).format(now),
    10,
  )
  if (!Number.isFinite(hour)) return "Hello"
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  return "Good evening"
}

/** "3 jobs to work on today" / "1 job to work on today" / "Nothing to work on today". */
export function workTodayText(count: number): string {
  if (count <= 0) return "Nothing to work on today"
  return `${count} job${count === 1 ? "" : "s"} to work on today`
}
