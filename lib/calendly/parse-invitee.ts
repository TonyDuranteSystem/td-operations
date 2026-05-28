/**
 * Calendly webhook payload parser.
 *
 * Lives in lib/ (not the route file) so it can be unit-tested directly — Next.js
 * route modules may only export GET/POST/etc., not helper functions.
 *
 * Shape note (verified against a live booking 2026-05-27/28): real Calendly v2
 * webhooks place the invitee fields DIRECTLY on payload.payload (email, name,
 * first_name, last_name, timezone, tracking, questions_and_answers,
 * scheduled_event). A synthetic test payload once nested them under
 * payload.payload.invitee — a wrapper that never appears in real Calendly
 * traffic. This parser accepts BOTH shapes.
 */

export interface ParsedQA {
  question: string
  answer: string
}

export interface ParsedInvitee {
  email: string
  name: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  /** "Italian" | "English" | null — system canonical values (see leads.language). */
  language: string | null
  callDate: string | null
  /** Full ISO start_time (date + time), or null. */
  callTime: string | null
  /** IANA timezone of the invitee, e.g. "Europe/Berlin". */
  timezone: string | null
  reason: string | null
  referrerName: string | null
  referralCode: string | null
  eventUri: string | null
  eventTypeName: string | null
  /** Meeting join URL (Zoom/Meet/etc.) if the event has an online location. */
  meetingUrl: string | null
  /** All form questions + answers, normalized. */
  qa: ParsedQA[]
}

/**
 * Flexible language detection. Calendly sends the chosen option's TEXT (not a
 * locale code), so we interpret it. We do NOT hardcode the exact button label —
 * we detect by word-stem / flag / 2-letter code, so the option can be renamed
 * ("Italian", "Italiano", "🇮🇹 Italiano", "it"…) and still resolve. Returns the
 * system-canonical "Italian" / "English", or null when nothing clearly matches
 * (callers leave language empty; downstream defaults to English).
 */
export function detectLanguage(qa: ParsedQA[]): string | null {
  // 1. Prefer the answer to a question that is clearly about language.
  for (const item of qa) {
    const q = (item.question || "").toLowerCase()
    if (q.includes("language") || q.includes("lingua")) {
      const loose = langFromAnswer(item.answer || "", true)
      if (loose) return loose
    }
  }
  // 2. Fallback: scan all answers, but STRICT (exact-ish word only) so a free-text
  //    answer like "raising capital" (contains "ital") can't false-match.
  for (const item of qa) {
    const strict = langFromAnswer(item.answer || "", false)
    if (strict) return strict
  }
  return null
}

function langFromAnswer(answer: string, loose: boolean): string | null {
  const raw = answer || ""
  const lower = raw.toLowerCase()
  // Flag emojis are unambiguous regardless of loose/strict.
  if (raw.includes("🇮🇹")) return "Italian"
  if (raw.includes("🇬🇧") || raw.includes("🇺🇸")) return "English"

  if (loose) {
    // We already know this is the language question — substring stems are safe.
    if (lower.includes("ital")) return "Italian"
    if (lower.includes("ingl") || lower.includes("engl")) return "English"
    const lettersLoose = lower.replace(/[^a-z]/g, "")
    if (lettersLoose === "it") return "Italian"
    if (lettersLoose === "en") return "English"
    return null
  }

  // STRICT: the whole answer (letters only) must BE a language word/code.
  const letters = lower.replace(/[^a-z]/g, "")
  if (["it", "ita", "ital", "italian", "italiano", "italiana"].includes(letters)) return "Italian"
  if (["en", "eng", "english", "inglese", "ingles"].includes(letters)) return "English"
  return null
}

/**
 * Phone extraction. Calendly's dedicated phone field is usually empty (the number
 * is collected via a custom form question). So: dedicated field → a question that
 * mentions phone/telefono/numero/whatsapp → any answer that looks like a phone
 * number. Returns null if none found.
 */
export function extractPhone(invitee: Record<string, unknown>, qa: ParsedQA[]): string | null {
  const direct =
    (invitee.phone_number as string) || (invitee.text_reminder_number as string) || ""
  if (direct && direct.trim()) return direct.trim()

  for (const item of qa) {
    const q = (item.question || "").toLowerCase()
    if (
      q.includes("phone") ||
      q.includes("telefono") ||
      q.includes("numero") ||
      q.includes("whatsapp")
    ) {
      if (item.answer && item.answer.trim()) return item.answer.trim()
    }
  }
  // Fallback: an answer that looks like a phone number (digits, optional +, separators).
  for (const item of qa) {
    const ans = (item.answer || "").trim()
    if (/^\+?[\d][\d\s().-]{6,}$/.test(ans)) return ans
  }
  return null
}

export function extractInviteeFields(
  payload: Record<string, unknown>
): ParsedInvitee | null {
  const p = ((payload.payload as Record<string, unknown>) || {}) as Record<string, unknown>
  // Prefer the nested invitee object if present (legacy/synthetic), otherwise read
  // the fields directly off payload.payload (real Calendly v2).
  const invitee = ((p.invitee as Record<string, unknown>) ?? p) as Record<string, unknown>
  if (!invitee?.email) return null

  const email = (invitee.email as string).toLowerCase().trim()
  const name = (invitee.name as string) || email.split("@")[0]
  const firstName = (invitee.first_name as string) || null
  const lastName = (invitee.last_name as string) || null
  const timezone = (invitee.timezone as string) || null

  const scheduledEvent = p.scheduled_event as Record<string, unknown> | undefined
  const callTime = (scheduledEvent?.start_time as string) || null
  const callDate = callTime ? callTime.split("T")[0] : null

  // Meeting join URL (online events: zoom/google_meet/microsoft_teams/etc.).
  let meetingUrl: string | null = null
  const location = scheduledEvent?.location as Record<string, unknown> | undefined
  if (location && typeof location.join_url === "string") {
    meetingUrl = location.join_url as string
  }

  const rawQA = invitee.questions_and_answers as
    | Array<{ question?: string; answer?: string }>
    | undefined
  const qa: ParsedQA[] = (rawQA ?? [])
    .map((x) => ({ question: (x.question || "").trim(), answer: (x.answer || "").trim() }))
    .filter((x) => x.answer)

  const phone = extractPhone(invitee, qa)
  const language = detectLanguage(qa)

  // Reason + "how did you hear" from the form. Keep keyword matching; skip the
  // phone/language answers so the fallback can't grab them by mistake.
  let reason: string | null = null
  let referrerName: string | null = null
  for (const item of qa) {
    const q = item.question.toLowerCase()
    if (q.includes("hear about") || q.includes("find out") || q.includes("referral") || q.includes("come ci hai") || q.includes("conoscenza")) {
      referrerName = item.answer || null
    } else if (q.includes("reason") || q.includes("motivo") || q.includes("help") || q.includes("interest")) {
      reason = item.answer || null
    }
  }
  if (!reason) {
    const firstMeaningful = qa.find(
      (item) =>
        item.answer !== phone &&
        item.answer !== referrerName &&
        langFromAnswer(item.answer, false) === null &&
        !/^\+?[\d][\d\s().-]{6,}$/.test(item.answer)
    )
    if (firstMeaningful && firstMeaningful.answer !== referrerName) reason = firstMeaningful.answer
  }

  const eventUri = (p.event as string) || null

  // Referral code travels via the landing page's Calendly link (UTM); the `a1`
  // prefill lands in questions_and_answers.
  const tracking = p.tracking as Record<string, unknown> | undefined
  let referralCode: string | null =
    (tracking?.utm_campaign as string) || (tracking?.utm_content as string) || null
  if (!referralCode && qa.length) {
    for (const item of qa) {
      if (/^[A-Z0-9]+-\d{4}(-\d+)?$/.test(item.answer)) {
        referralCode = item.answer
        break
      }
    }
  }

  return {
    email,
    name,
    firstName,
    lastName,
    phone,
    language,
    callDate,
    callTime,
    timezone,
    reason,
    referrerName,
    referralCode,
    eventUri,
    eventTypeName: (scheduledEvent?.name as string) || null,
    meetingUrl,
    qa,
  }
}

/**
 * Human-readable notes block for the lead, capturing the booking context that has
 * no dedicated column (call type, exact time + timezone, meeting link, and the
 * full Q&A so nothing the invitee typed is lost).
 */
export function buildLeadNotes(f: ParsedInvitee): string {
  const lines: string[] = []
  lines.push(`Booked via Calendly${f.eventTypeName ? `: ${f.eventTypeName}` : ""}`)
  if (f.callTime) {
    const when = f.timezone ? `${f.callTime} (${f.timezone})` : f.callTime
    lines.push(`When: ${when}`)
  }
  if (f.meetingUrl) lines.push(`Meeting: ${f.meetingUrl}`)
  if (f.qa.length) {
    lines.push("---")
    for (const item of f.qa) {
      // Questions can be long bilingual blocks; keep the first line, capped.
      const q = item.question.split("\n")[0].trim().slice(0, 90)
      lines.push(`Q: ${q} → ${item.answer}`)
    }
  }
  return lines.join("\n")
}
