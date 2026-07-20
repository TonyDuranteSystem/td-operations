/**
 * Cross-border tax/visa side-check for the portal-chat reply suggester
 * (dev job 09cc3aec, council-reviewed 2026-07-20).
 *
 * The reply-suggestion route (app/api/portal/chat/suggest/route.ts) drafts a
 * reply in one AI pass today. Real case (Luca Del Prete, 2026-07-20): a client
 * question that touched Italian VAT/permanent-establishment exposure got a
 * correct-as-far-as-it-went reply, but missed two deeper risks (his personal
 * Italian tax-residency status, and whether the LLC itself could be treated as
 * Italian-resident) that a dedicated cross-border lens caught in a Council trial.
 *
 * This module adds a CHEAP keyword gate (no AI call) that only fires the two
 * extra advisory passes when a client message plausibly touches foreign tax or
 * visa/relocation topics. These are NOT the Council specialist prompts verbatim
 * (per Council review 2026-07-20: those are written for a citation-and-verdict
 * subagent workflow, not a single chat message) — they are purpose-written,
 * plain-language advisory prompts carrying the same two hard rules:
 *   1. Anti-staleness — never assert a foreign country's rate/rule/visa
 *      category as settled fact; flag it as needing local verification.
 *   2. Client-relay guardrail — output is an internal note for staff, never
 *      something to relay to the client directly.
 *
 * Failure isolation: a specialist call failing must NEVER block or degrade the
 * main suggested draft. Callers should always fall back to an empty/error note
 * on failure, never throw.
 */

/** Bilingual (EN/IT) signal words — a client's OWN words, not account metadata,
 * are the real signal (per Council: citizenship/state-of-formation mismatch is
 * true for nearly every TD client, so it doesn't discriminate). */
const CROSS_BORDER_KEYWORDS = [
  // English
  "vat", "tax treaty", "double tax", "visa", "residency", "resident", "relocat",
  "dividend", "permanent establishment", "immigration", "citizenship",
  // Italian
  "iva", "imposta", "imposte", "tasse", "residenza", "residente", "trasfer",
  "dividendi", "stabile organizzazione", "cittadinanza", "permesso di soggiorno",
  "commercialista",
]

/**
 * True if any of the last few CLIENT messages (not just the newest one)
 * contains a cross-border signal word. Scanning a short window, not just the
 * latest line, catches "client raised it 2 messages ago, just wrote 'ok thanks'
 * now" (Senior Engineer finding, 2026-07-20).
 */
export function detectCrossBorderSignal(
  recentClientMessages: string[],
  windowSize = 3,
): boolean {
  const window = recentClientMessages.slice(-windowSize)
  return window.some((msg) => {
    const lower = msg.toLowerCase()
    return CROSS_BORDER_KEYWORDS.some((kw) => lower.includes(kw))
  })
}

export type CrossBorderNote = {
  lens: "foreign_tax" | "immigration_visa"
  label: string
  status: "ok" | "error"
  text: string
}

const CLIENT_RELAY_GUARDRAIL =
  "This is an INTERNAL note for TD staff only. Never copy this into a message " +
  "to the client. Never state a foreign country's tax rate, treaty provision, " +
  "or visa rule as settled fact — say what needs checking, and end every point " +
  "with: confirm with the client's own local professional before this becomes " +
  "anything the client acts on."

const FOREIGN_TAX_PROMPT = `You are an internal screening assistant for Tony Durante LLC, a US firm helping non-US clients form and run US LLCs. A staff member is about to reply to a client message that may touch FOREIGN-COUNTRY tax exposure — VAT/GST from LLC activity abroad, permanent-establishment risk from an ongoing foreign presence, whether the client's personal tax residency in their home country is genuinely broken, or whether a foreign tax authority could treat the LLC itself as resident there because the owner-operator lives in or is a citizen of that country.

${CLIENT_RELAY_GUARDRAIL}

You are NOT drafting the client reply — a separate call already does that. Read the client's account context and conversation below. If nothing here plausibly touches foreign tax exposure, reply with exactly: NONE. Otherwise, in 3-5 short bullet points, name the specific unaddressed risk(s) or confirm what's already been correctly flagged — plain language, no jargon, no code/file references, under 150 words total.`

const IMMIGRATION_VISA_PROMPT = `You are an internal screening assistant for Tony Durante LLC, a US firm helping non-US clients form and run US LLCs. A staff member is about to reply to a client message that may touch VISA/RELOCATION status — whether a visa or residency category the client holds legally permits passive income like LLC dividends, whether operating/managing the LLC from a given country could jeopardize a visa category that restricts local work/business activity, or timing risk around a relocation.

${CLIENT_RELAY_GUARDRAIL}

You are NOT drafting the client reply — a separate call already does that. Read the client's account context and conversation below. If nothing here plausibly touches visa/immigration status, reply with exactly: NONE. Otherwise, in 3-5 short bullet points, name the specific unaddressed risk(s) or confirm what's already been correctly flagged — plain language, no jargon, no code/file references, under 150 words total.`

/**
 * Run both advisory lenses in parallel. Never throws — a failed lens is
 * reported with status "error" and a short message; it never blocks or
 * degrades the caller's main suggestion.
 */
export async function runCrossBorderChecks(userMessage: string): Promise<CrossBorderNote[]> {
  const { callWorkerWithAttachments } = await import("@/lib/ai-agent/attachment-reader")

  const lenses: Array<{ lens: CrossBorderNote["lens"]; label: string; prompt: string }> = [
    { lens: "foreign_tax", label: "Foreign tax exposure", prompt: FOREIGN_TAX_PROMPT },
    { lens: "immigration_visa", label: "Visa / immigration", prompt: IMMIGRATION_VISA_PROMPT },
  ]

  const results = await Promise.allSettled(
    lenses.map(({ prompt }) =>
      callWorkerWithAttachments(userMessage, {
        systemPromptOverride: prompt,
        enableWebSearch: true,
        maxIterations: 4,
      }),
    ),
  )

  return results.map((res, i) => {
    const { lens, label } = lenses[i]
    if (res.status === "rejected") {
      console.warn(`[cross-border-check] ${lens} lens failed:`, res.reason)
      return { lens, label, status: "error", text: "Check unavailable — see logs." }
    }
    const text = res.value.reply?.trim() ?? ""
    if (!text || text.toUpperCase() === "NONE") {
      return { lens, label, status: "ok", text: "" }
    }
    return { lens, label, status: "ok", text }
  })
}
