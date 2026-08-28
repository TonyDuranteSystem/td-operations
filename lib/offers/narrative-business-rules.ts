/**
 * Offer-narrative BUSINESS RULES + prompt assembly — pure and testable.
 *
 * WHY: the offer-narrative generator used to hardcode Tony Durante's service
 * model, exclusions, and per-entity-type tax filing as prompt prose. Those are
 * BUSINESS RULES; per Antonio they must live where business rules live (the
 * knowledge base) and be editable by him. The generator loads the article
 * tagged `OFFER_NARRATIVE_RULES_TAG` and injects it into every offer narrative,
 * for EVERY contract type. This module holds the pure pieces: the lookup tag, a
 * MINIMAL fail-safe floor, the KB-vs-fallback resolver, service rendering, and
 * the system/user prompt builders — so the whole prompt a client's offer is
 * generated from can be simulated end-to-end without an AI call.
 *
 * FALLBACK IS A FLOOR, NOT A MIRROR (council fix): the fallback deliberately
 * carries only the non-negotiable guardrails (never bookkeeping; stay generic on
 * tax unless the filing is known; describe only what's sold). The rich, editable
 * content — per-entity filing, portal features, management services — lives ONLY
 * in the knowledge-base article, so there is exactly ONE source of substantive
 * truth and nothing to keep "in sync". If the article can't load, the writer
 * degrades to the safe floor (never fail-open) and the route logs it loudly.
 */

/** Tag on the single knowledge-base article that holds these rules. */
export const OFFER_NARRATIVE_RULES_TAG = 'offer_narrative_rules'

/**
 * MINIMAL fail-safe floor — used only when the knowledge-base article can't be
 * loaded. Just the non-negotiable guardrails. It must never promise bookkeeping
 * and must keep tax wording generic when the specific filing isn't given.
 */
export const FALLBACK_BUSINESS_RULES = `Tony Durante does NOT offer bookkeeping, accounting-system setup, transaction recording, financial reporting, personal tax return preparation, or tax planning/advisory. NEVER mention, imply, promise, or ask about any of them, and never ask the client to summarize their transactions, bank activity, or income for bookkeeping purposes.
Describe ONLY the services in SELECTED SERVICES. For the U.S. tax filing, stay GENERAL ("your annual U.S. federal filing, prepared and filed through our accountant") unless the ENTITY TYPE makes the specific filing clear — never assume income-tax preparation or bookkeeping.`

/** Where the injected business rules came from — so the caller can log a
 * missing/mistagged article (a config error) distinctly from a transient blip. */
export type BusinessRulesSource = 'kb' | 'fallback_missing' | 'fallback_error'

/**
 * Resolve the business rules from a knowledge-base row (or null). Pure so the
 * route's fetch stays thin and this is unit-testable. A present, non-empty
 * article wins; anything else falls back to the floor. `source` distinguishes a
 * genuinely-absent article (`fallback_missing` — a CONFIG error worth shouting
 * about) from the caller's own DB error path (`fallback_error`).
 */
export function resolveBusinessRules(
  article: { content?: string | null } | null | undefined,
): { rules: string; source: BusinessRulesSource } {
  const content = article?.content?.trim()
  if (content) return { rules: content, source: 'kb' }
  return { rules: FALLBACK_BUSINESS_RULES, source: 'fallback_missing' }
}

/** The contract types that mean the offer carries ongoing management (and thus
 * legitimately describes registered agent / annual filing / the Client Portal).
 * Standalone contract types (itin, tax_return, banking, etc.) are NOT here. */
export const MANAGEMENT_CONTRACT_TYPES: ReadonlySet<string> = new Set([
  'formation',
  'onboarding',
  'renewal',
])

/**
 * Server-side fallback for whether an offer includes ongoing management, derived
 * from its contract type. The Create Offer dialog sends an explicit, more precise
 * `includes_management` boolean (computed from the actual selected services); this
 * is the backstop for that value being absent. Never defaults to true.
 */
export function offerIncludesManagement(contractType?: string | null): boolean {
  return MANAGEMENT_CONTRACT_TYPES.has((contractType || '').trim())
}

/** A selected service as it may arrive from the dialog: a bare name, or a
 * name plus its catalog description (the editable source of truth). */
export type NarrativeServiceInput = string | { name?: string | null; description?: string | null }

/**
 * Render the selected services into "Name — description" lines for the prompt,
 * reading the description straight from the catalog value the caller passed.
 * Pure + exported so it's unit-tested without a route/AI call. Drops blank
 * entries; a service with no description renders as just its name.
 */
export function renderServiceLines(services: NarrativeServiceInput[]): string[] {
  const lines: string[] = []
  for (const svc of services) {
    if (typeof svc === 'string') {
      const name = svc.trim()
      if (name) lines.push(name)
      continue
    }
    if (!svc || typeof svc !== 'object') continue
    const name = (svc.name || '').trim()
    if (!name) continue
    const desc = (svc.description || '').trim()
    lines.push(desc ? `${name} — ${desc}` : name)
  }
  return lines
}

/**
 * Build the system prompt. `businessRules` is the resolved KB/fallback text.
 * `includesManagement` gates the standard-management / Client-Portal language:
 * a narrow standalone offer (e.g. ITIN-only, notary-only) must NOT promise
 * registered agent / annual filing / the portal the client didn't buy — the
 * council's over-promise fix.
 */
export function buildSystemPrompt(
  language: 'en' | 'it',
  businessRules: string,
  includesManagement: boolean,
  hasMultipleOptions: boolean,
): string {
  // Single-language intro — match the client's preferred language only. The
  // access-code offer page renders both fields; generating both produced
  // bilingual welcome blocks for monolingual clients, so we fill only the match.
  const introSpec = language === 'it'
    ? `- "intro_it": A rich, 4-6 sentence personalized introduction in NATURAL Italian (not machine-translated). Open by referencing what the client actually shared on their call — their business, their goal, a specific concern or opportunity they raised. Then explain what this offer is designed to do for them and why this approach fits their situation. Make it personal and specific to THIS client, never generic.
- "intro_en": MUST be an empty string "". Do not produce English intro content.`
    : `- "intro_en": A rich, 4-6 sentence personalized introduction in English. Open by referencing what the client actually shared on their call — their business, their goal, a specific concern or opportunity they raised. Then explain what this offer is designed to do for them and why this approach fits their situation. Make it personal and specific to THIS client, never generic.
- "intro_it": MUST be an empty string "". Do not produce Italian intro content.`

  const otherSectionsLang = language === 'it' ? 'Italian' : 'English'

  const managementRule = includesManagement
    ? `SCOPE — this offer INCLUDES ongoing management. In addition to the SELECTED SERVICES, you SHOULD describe the standard management services and the Client Portal exactly as defined in the BUSINESS RULES below.`
    : `SCOPE — this offer does NOT include ongoing management. Describe ONLY the SELECTED SERVICES. Do NOT mention registered agent, annual/state-compliance filings, mail handling, "ongoing management", or the Client Portal UNLESS a SELECTED SERVICE explicitly provides it.`

  // Antonio's bug report (dev job 3c1bb5fa, 2026-08-26): the writer had no idea
  // a package offer even had multiple options, so the intro read like a normal
  // single-price offer and never told the client a choice existed. The offer
  // page itself shows the options' real details (price/state/company type) —
  // the writer must not invent or restate them, only point the client there.
  const multipleOptionsRule = hasMultipleOptions
    ? `\n\nMULTIPLE OPTIONS: This offer presents the client with more than one option to choose from (different combinations of price, U.S. state, and/or company type) on the offer page. In the intro, explicitly tell the client that this offer includes multiple options and that they should review each one on the offer page and select the one that fits them best. Do NOT describe what the specific options are, their prices, or their states — you were not given those details and the client sees them directly.`
    : ''

  return `You are a senior business consultant at Tony Durante LLC, a professional consulting firm based in Florida that helps international entrepreneurs set up and manage U.S. LLCs.

Your job is to write a rich, professional, client-facing offer narrative — NOT a terse summary. The client reads this before signing, so it should feel like a tailored strategy memo from a consultant who listened carefully to their call and understands their situation deeply.

Your writing style is:
- Professional but warm and approachable — a trusted advisor, not a salesperson
- Specific: pull real details from the call/notes (business model, country, goals, concerns raised). Every sentence should be about THIS client, not a template
- Confident and authoritative about the services
- No filler, no jargon

You must produce ALL output as a single JSON object with exactly these keys:
${introSpec}
- "strategy": An array of 4-5 strategic steps. Each: { "step_number": N, "title": "Short Title", "description": "2-3 sentence explanation of WHY this step matters for this client specifically, grounded in their situation — not just what it is" }. These describe the overall approach/plan for the client.
- "next_steps": An array of 4-5 next steps after signing. Each: { "step_number": N, "title": "Short Title", "description": "2-3 sentences: what happens, who does what, and what the client can expect" }. These describe what happens operationally after the client signs.
- "future_developments": An array of 3-4 items. Each: { "text": "A concrete future opportunity tied to the CLIENT'S OWN business trajectory — new markets, growth, hiring, a structure change — 1-2 sentences. NOT a pitch for additional Tony Durante services unless that service is already in the offer, and NEVER bookkeeping/accounting/tax-planning" }. These are the client's own growth opportunities for later.
- "immediate_actions": An array of 2-3 items. Each: { "title": "Action Name", "description": "2-3 sentences: what needs to happen right away and why it matters for this client" }. These are things to address right away.

LANGUAGE RULES (CRITICAL):
- The client's preferred language is ${otherSectionsLang}. Generate ALL content in ${otherSectionsLang} only.
- The intro field for the OTHER language MUST be an empty string ""; do NOT translate or duplicate the intro into the other language.
- "strategy", "next_steps", "future_developments", and "immediate_actions" MUST be written in ${otherSectionsLang}.

CONTRACT TYPE — structural rule only (what stage the company is at):
- "formation": the client is forming a BRAND NEW company. You MAY describe forming the company, applying for the EIN, state filing, and initial registered-agent setup.
- "onboarding": the client ALREADY HAS a company and is joining ongoing management. Do NOT mention forming the company, registering it, or gathering formation documents — it already exists. Describe taking the existing company under management.
- "renewal": the client is renewing an existing management agreement. Emphasize continuity and the coming year.

${managementRule}${multipleOptionsRule}

BUSINESS RULES — AUTHORITATIVE, follow EXACTLY. These define what Tony Durante does and does NOT offer, the tax filing by company type, and the Client Portal. They override anything in the notes or your own assumptions:
${businessRules}

Other rules:
- Output ONLY the JSON object. No markdown, no code fences, no explanation.
- Describe ONLY the services in SELECTED SERVICES, plus (only if this offer includes ongoing management) the standard management/portal features in the BUSINESS RULES. NEVER invent, imply, or promise a service that is not in the offer.
- Use the ENTITY TYPE in the user message to pick the correct tax-filing wording from the BUSINESS RULES. If ENTITY TYPE is not specified, OR the BUSINESS RULES do not state the filing for this entity type, keep the tax wording general ("your annual U.S. federal filing, prepared and filed through our accountant") — never invent a form, a schedule, or any bookkeeping. Never state the client's specific tax liability as a promise.
- Always address the client by the exact CLIENT name given in the user message. The notes/transcript may mention other people (referrers, previous providers, family) — NEVER greet or address the client by a name found in the notes; use only the CLIENT name provided.
- The intro must reference the client's actual situation, not be generic.
- Do NOT include pricing or amounts — those are handled separately.
- Do NOT include legal disclaimers — the contract handles those.`
}

/**
 * System prompt for REFINING an existing narrative via a chat instruction.
 * Reuses the SAME authoritative business rules, scope gate, and language rule as
 * generation — a refined offer must never drift from a freshly-generated one, and
 * an instruction can NEVER weaken the hard rules (no bookkeeping, correct filing,
 * no over-promise). Output contract: return ONLY the sections actually changed, so
 * untouched sections (including the staff member's hand-edits) are never clobbered.
 */
export function buildRefineSystemPrompt(
  language: 'en' | 'it',
  businessRules: string,
  serviceMenu?: string,
): string {
  const lang = language === 'it' ? 'Italian' : 'English'
  const introKey = language === 'it' ? 'intro_it' : 'intro_en'
  const reference = [
    businessRules ? `About Tony Durante (facts to help you write accurately — reference, NOT restrictions):\n${businessRules}` : '',
    serviceMenu && serviceMenu.trim() ? `Services Tony Durante offers:\n${serviceMenu.trim()}` : '',
  ].filter(Boolean).join('\n\n')

  return `You are the writing assistant for Antonio at Tony Durante LLC. He is refining a client-facing offer narrative and tells you, in his own words, what he wants it to say. HE is the author and decides the content — your job is to write what he asks, clearly and professionally. Do NOT refuse, judge, lecture, second-guess, or add disclaimers or corrections. Apply his instruction faithfully and flexibly. He reviews every offer before it is sent.

OUTPUT CONTRACT (critical):
- Return a single JSON object: { "note": "<one short sentence: what you changed>", "changes": { ... } }.
- "changes" contains ONLY the sections you actually changed, using these exact keys when changed: "${introKey}" (string), "strategy" (array of {step_number, title, description}), "next_steps" (same shape), "future_developments" (array of {text}), "immediate_actions" (array of {title, description}).
- Do NOT include a section you did not change. If nothing changed, return "changes": {}.
- NEVER return the other-language intro. Only "${introKey}" may be set.
- Output ONLY the JSON object. No markdown, no code fences.

HOW TO WRITE:
- His message is instruction + context about the client. Use BOTH to produce the wording he wants — say exactly what he tells you to say, in a polished client-facing voice.
- Only touch the section(s) his instruction is about; leave every other section exactly as it is (don't return it), so his other edits are preserved.
- Write in ${lang}. Address the client by the CLIENT name given (never a name from the notes). Don't include pricing/amounts.
- Don't invent specific facts he didn't give you; otherwise follow his instruction.
- If a RELEVANT EMAIL block is given, it was found specifically for this instruction — ground your answer in what it actually says. If no such block is given, answer from the instruction and current narrative alone; don't claim to have checked an email you weren't shown.

${reference}`
}

/** User prompt for a refine round: the current narrative (as the staff member
 * currently has it, including hand-edits) + the offer context + the instruction. */
export function buildRefineUserPrompt(opts: {
  clientName: string
  contractType: string
  entityType: string
  serviceLines: string[]
  current: { intro_en?: string; intro_it?: string; strategy?: string; next_steps?: string; future_developments?: string; immediate_actions?: string }
  instruction: string
  // The relevant email thread text, when the instruction referenced one and a
  // matching thread was actually found — see findRelevantEmailContext() in
  // the route. Absent (not just empty) whenever no lookup was attempted or
  // nothing matched, so the prompt never implies a lookup happened when it didn't.
  emailContext?: string
}): string {
  const c = opts.current
  const emailBlock = opts.emailContext
    ? `\nRELEVANT EMAIL (found for this instruction — use it, don't invent beyond it):\n${opts.emailContext}\n`
    : ''
  return `CLIENT: ${opts.clientName}
CONTRACT TYPE: ${opts.contractType}
ENTITY TYPE: ${opts.entityType || 'Not specified — keep tax wording generic'}
SELECTED SERVICES:
${opts.serviceLines.map((s) => `- ${s}`).join('\n')}

CURRENT NARRATIVE (refine from exactly this — leave any section you are not asked to change out of "changes"):
[intro_en]: ${c.intro_en || '(empty)'}
[intro_it]: ${c.intro_it || '(empty)'}
[strategy]: ${c.strategy || '(empty)'}
[next_steps]: ${c.next_steps || '(empty)'}
[future_developments]: ${c.future_developments || '(empty)'}
[immediate_actions]: ${c.immediate_actions || '(empty)'}
${emailBlock}
INSTRUCTION FROM STAFF: ${opts.instruction}

Return the JSON now.`
}

/** Build the user prompt from the concrete offer inputs. `serviceLines` are the
 * pre-rendered "Name — description" lines from {@link renderServiceLines}. */
export function buildUserPrompt(
  clientName: string,
  language: 'en' | 'it',
  serviceLines: string[],
  notesContext: string,
  contractType: string,
  entityType: string,
): string {
  return `Generate offer narrative content for this client:

CLIENT: ${clientName}
PREFERRED LANGUAGE: ${language === 'it' ? 'Italian' : 'English'}
CONTRACT TYPE: ${contractType}
ENTITY TYPE: ${entityType || 'Not specified — keep tax wording generic, do not assume a form or any bookkeeping'}
SELECTED SERVICES (describe ONLY these, plus standard management/portal features ONLY if this offer includes ongoing management):
${serviceLines.map((s) => `- ${s}`).join('\n')}

NOTES & CONTEXT (internal — do not reproduce verbatim, use to personalize):
${notesContext || 'No additional notes provided.'}

Generate the JSON now.`
}
