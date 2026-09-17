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

/**
 * GROUNDING GATES (dev job 2b6e5988 fix + council redesign, 2026-09-16).
 *
 * dev_task 2b6e5988: the generator invented "South Dakota" as the formation
 * state on a real client offer because neither the generate nor the refine
 * route was ever TOLD the real state — there was no field to send. These two
 * gates decide when it is safe to assert a specific state/entity type as fact
 * instead of leaving the writer to guess (or, worse, not guess and invent
 * something plausible-sounding). Both are re-checked SERVER-SIDE in the
 * narrative-chat route, never trusted from the dialog alone — the exact
 * surface where the bug below was found.
 *
 * `hasMultipleOptions` reuses the existing multi-option ambiguity signal: a
 * package picker means the offer doesn't have ONE state/entity-type, it has
 * several (one per option), so neither may be asserted as THE state/type.
 */

/**
 * Whether a formation state may be asserted as fact. Requires BOTH:
 * unambiguous (not multi-option) AND the offer's contract type is actually
 * 'formation' — a formation state is only meaningful when a company is
 * actually being formed in this narrative.
 *
 * The contract-type check is NOT redundant with the ambiguity check
 * (bug-hunter blocker): `formationState` is Create Offer dialog component
 * state that can survive a staffer switching a formation offer's selected
 * services to a different service type (e.g. onboarding/ITIN-only) — plain
 * `useState`, not recomputed from the current selection. `contractType` here
 * is expected to be the dialog's `derivedContractType`, a `useMemo` that IS
 * always recomputed from the live selection — so gating on it (rather than
 * on ambiguity alone) closes exactly the leak: a stale formation state can
 * never be asserted into a narrative whose contract type has since moved on.
 */
export function canGroundFormationState(opts: {
  contractType?: string | null
  hasMultipleOptions: boolean
}): boolean {
  return !opts.hasMultipleOptions && (opts.contractType || '').trim() === 'formation'
}

/**
 * Whether an entity type (SMLLC/MMLLC/Corp) may be asserted as fact. Unlike
 * formation state, entity type is meaningful for BOTH formation AND
 * onboarding offers — an onboarding client's already-existing company still
 * has an entity type that decides its tax filing (see buildUserPrompt's tax
 * wording) — so it is gated on ambiguity alone, not on contract type.
 *
 * Before this fix NEITHER route gated entity type at all: it was sent
 * unconditionally, so a multi-option offer whose packages disagreed on
 * entity type (SMLLC vs MMLLC) would still have ONE entity type asserted as
 * fact for the whole narrative — a live, real gap independent of the
 * conversational-memory redesign.
 */
export function canGroundEntityType(opts: { hasMultipleOptions: boolean }): boolean {
  return !opts.hasMultipleOptions
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
 * currently has it, including hand-edits) + the offer context + the instruction.
 * `formationState` must already be gated by the caller (see
 * {@link canGroundFormationState}) — omit/leave '' when it isn't safe to assert one. */
export function buildRefineUserPrompt(opts: {
  clientName: string
  contractType: string
  entityType: string
  formationState?: string
  serviceLines: string[]
  current: { intro_en?: string; intro_it?: string; strategy?: string; next_steps?: string; future_developments?: string; immediate_actions?: string }
  instruction: string
  // The relevant email thread text, when the instruction referenced one and a
  // matching thread was actually found — see findRelevantEmailContext() in
  // the route. Absent (not just empty) whenever no lookup was attempted or
  // nothing matched, so the prompt never implies a lookup happened when it didn't.
  emailContext?: string
  // A note about what changed on the offer SINCE this narrative was last
  // grounded (state/entity-type/package selection) — surfaced so the model
  // itself knows a hand-off happened, mirroring the dialog's own visible
  // staleness warning (see canGroundFormationState's header). Absent when
  // nothing is stale.
  staleGroundingNote?: string
}): string {
  const c = opts.current
  const emailBlock = opts.emailContext
    ? `\nRELEVANT EMAIL (found for this instruction — use it, don't invent beyond it):\n${opts.emailContext}\n`
    : ''
  const stateLine = opts.formationState
    ? `\nSTATE OF FORMATION: ${opts.formationState} — the ONLY state this offer forms in. Do not mention any other U.S. state.`
    : opts.contractType === 'formation'
      ? '\nSTATE OF FORMATION: Not specified — do NOT name or imply any specific U.S. state.'
      : ''
  const staleBlock = opts.staleGroundingNote
    ? `\nNOTE: ${opts.staleGroundingNote}\n`
    : ''
  return `CLIENT: ${opts.clientName}
CONTRACT TYPE: ${opts.contractType}
ENTITY TYPE: ${opts.entityType || 'Not specified — keep tax wording generic'}${stateLine}
SELECTED SERVICES:
${opts.serviceLines.map((s) => `- ${s}`).join('\n')}

CURRENT NARRATIVE (refine from exactly this — leave any section you are not asked to change out of "changes"):
[intro_en]: ${c.intro_en || '(empty)'}
[intro_it]: ${c.intro_it || '(empty)'}
[strategy]: ${c.strategy || '(empty)'}
[next_steps]: ${c.next_steps || '(empty)'}
[future_developments]: ${c.future_developments || '(empty)'}
[immediate_actions]: ${c.immediate_actions || '(empty)'}
${emailBlock}${staleBlock}
INSTRUCTION FROM STAFF: ${opts.instruction}

Return the JSON now.`
}

/** Build the user prompt from the concrete offer inputs. `serviceLines` are the
 * pre-rendered "Name — description" lines from {@link renderServiceLines}.
 * `formationState` must already be gated by the caller (see
 * {@link canGroundFormationState}) — pass '' when it isn't safe to assert one;
 * this function does not re-derive the gate, it only renders the decision. */
export function buildUserPrompt(
  clientName: string,
  language: 'en' | 'it',
  serviceLines: string[],
  notesContext: string,
  contractType: string,
  entityType: string,
  formationState?: string,
): string {
  // dev_task 2b6e5988: the writer once invented "South Dakota" because it was
  // never told the real state at all — there was no field to send it in.
  // When the caller withheld a state (ambiguous or not a formation offer),
  // say so explicitly rather than leaving the line out, so the model reads
  // "don't invent one" instead of silently treating absence as a green light.
  const stateLine = formationState
    ? `\nSTATE OF FORMATION: ${formationState} — this is the ONLY state this offer forms in. Do not mention any other U.S. state.`
    : contractType === 'formation'
      ? '\nSTATE OF FORMATION: Not specified — this offer has more than one possible state/option, or the state was not pinned yet. Do NOT name or imply any specific U.S. state.'
      : ''
  return `Generate offer narrative content for this client:

CLIENT: ${clientName}
PREFERRED LANGUAGE: ${language === 'it' ? 'Italian' : 'English'}
CONTRACT TYPE: ${contractType}
ENTITY TYPE: ${entityType || 'Not specified — keep tax wording generic, do not assume a form or any bookkeeping'}${stateLine}
SELECTED SERVICES (describe ONLY these, plus standard management/portal features ONLY if this offer includes ongoing management):
${serviceLines.map((s) => `- ${s}`).join('\n')}

NOTES & CONTEXT (internal — do not reproduce verbatim, use to personalize):
${notesContext || 'No additional notes provided.'}

Generate the JSON now.`
}

/**
 * Recover a JSON object from a model completion that may not be pure JSON.
 *
 * The system prompt tells the model to output ONLY a JSON object, but a
 * CONVERSATIONAL turn (unlike the old one-shot generate/refine calls) can
 * carry a staff instruction that pulls against a hard rule elsewhere in the
 * same prompt — e.g. asked to fill in the language variant the LANGUAGE
 * RULES say must stay an empty string. Live-verified (2026-09-16): when that
 * happens the model wraps or replaces the JSON with an explanation instead
 * of refusing outright, which stripping a code fence alone (the old routes'
 * only defense) cannot recover from.
 *
 * Recovers by slicing between the first '{' and the last '}' — a real JSON
 * object's own outermost braces once fence markers are gone, so any prose
 * before/after them is exactly what this discards. Falls through to the
 * fence-stripped string unchanged if no brace pair is found, so the caller's
 * own JSON.parse still produces the original, diagnosable error rather than
 * this helper inventing a different one.
 */
export function extractJsonObject(rawText: string): string {
  const fenceStripped = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  const start = fenceStripped.indexOf('{')
  const end = fenceStripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return fenceStripped
  return fenceStripped.slice(start, end + 1)
}

/** Same UI copy as the field labels in components/offers/create-offer-dialog.tsx
 * (minus the "(JSON array)" format hint, which doesn't belong in a chat sentence). */
export const NARRATIVE_FIELD_LABELS: Record<string, string> = {
  intro_en: 'Introduction (English)',
  intro_it: 'Introduction (Italian)',
  strategy: 'Strategy',
  next_steps: 'Next Steps',
  future_developments: 'Future Developments',
  immediate_actions: 'Immediate Actions',
}

/** Order-independent for object keys, order-sensitive for arrays (reordering
 * steps is a real change here, not noise). No existing deep-equal dependency
 * in this codebase for a comparison this small. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

/**
 * Reconstruct "what the AI last set each narrative field to", by replaying
 * stored turns in order and overlaying each assistant turn's fields onto a
 * running snapshot. Turn 1's assistant content is the FULL narrative at the
 * top level; every later turn's assistant content is a `{ note, changes }`
 * delta holding only the fields that turn actually changed (see
 * narrative-conversation.ts's module header for why turns are stored this
 * way) — so a field untouched since turn 1 is still correctly found there.
 *
 * Feeds ONLY an advisory hand-edit-loss note (detectOverwrittenHandEdits,
 * below) — never a decision that can block or alter the actual response —
 * so a turn whose stored content isn't parseable JSON is silently skipped
 * rather than thrown.
 */
export function reconstructAiNarrativeBaseline(
  turns: { role: string; content: string }[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(extractJsonObject(turn.content))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    const fields = (obj.changes && typeof obj.changes === 'object') ? obj.changes as Record<string, unknown> : obj
    for (const key of Object.keys(NARRATIVE_FIELD_LABELS)) {
      if (key in fields) snapshot[key] = fields[key]
    }
  }
  return snapshot
}

/**
 * Isolate what a human likely INSERTED into a plain-text field: the longest
 * common prefix and suffix between `before` and `after` are trimmed off,
 * leaving whatever's left in the middle of `after`. Exact for a pure
 * insertion (someone clicked into the middle of a sentence and typed) —
 * the common real-world case this function exists for. For a deletion or a
 * more tangled edit it can return an empty string even though `after`
 * genuinely differs from `before`; the caller treats that as "can't isolate
 * the inserted text" and falls back to its own, more conservative check,
 * not as "nothing was edited."
 */
function extractInsertedMiddle(before: string, after: string): string {
  let prefixLen = 0
  while (prefixLen < before.length && prefixLen < after.length && before[prefixLen] === after[prefixLen]) prefixLen++
  let suffixLen = 0
  const maxSuffix = Math.min(before.length - prefixLen, after.length - prefixLen)
  while (
    suffixLen < maxSuffix &&
    before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
  ) suffixLen++
  return after.slice(prefixLen, after.length - suffixLen)
}

/**
 * Which of THIS turn's changed fields the human had ALSO hand-edited (typed
 * directly into the field) since the AI last touched it, where the AI's OWN
 * new value for that field no longer reflects that edit — i.e. an edit this
 * turn's response actually lost, not just touched. `current` holds the
 * on-screen values exactly as the dialog's textareas hold them (plain string
 * for the two intros, JSON text for the array fields) at the moment this
 * turn was sent, BEFORE this turn's own edit is applied; `changes` is this
 * turn's own actual output (`validateNarrativeChanges`'s `changes`) for the
 * fields it decided to touch.
 *
 * Live-verified gap (2026-09-16 stress test): a broad instruction that
 * legitimately needs to rewrite a field (e.g. the entity type changed, so
 * the intro must too) silently discarded a sentence Antonio had typed by
 * hand into that same field, with no warning. Antonio's chosen fix (of two
 * offered) is to WARN rather than block: the AI still makes the correction
 * so nothing stays factually wrong, but the chat reply now says so.
 *
 * Live-verified FALSE POSITIVE this warning must not repeat (found re-testing
 * the fix itself, same day): the model can be smart enough to weave a
 * correction around a hand-typed sentence and keep it verbatim — in which
 * case nothing was actually lost, and warning anyway would just be crying
 * wolf. For the two plain-text intro fields, this isolates the human's
 * inserted text (via `extractInsertedMiddle`, above) and only flags when the
 * NEW value no longer contains it — an edit the AI's own output still
 * carries is not a loss. The two array/JSON fields keep the coarser
 * "did the value change from what the AI last set it to" check (no
 * character-level insertion concept for structured JSON); this is a known,
 * accepted scope boundary — flagged here, not silently pretended away — and
 * could over-warn there in the equivalent scenario if it's ever hit live.
 *
 * KNOWN LIMITATION, disclosed rather than silently accepted (found in the
 * SAME re-test that caught the false positive above): protection lasts for
 * ONE turn only. Once a hand-edit survives a turn, the AI's own output for
 * that turn — the only thing this function has to compare against for the
 * NEXT turn — now legitimately contains it, so it looks exactly like
 * AI-authored content from then on. A LATER turn that drops it will not be
 * flagged, because by then `current` and the reconstructed baseline agree
 * with each other; there is no more "hand-edit" signal left to see. Fixing
 * this for real would mean persisting hand-edit provenance across the whole
 * conversation, not just diffing against the immediately preceding turn —
 * real added scope, not built here without checking first. What IS covered:
 * the common case this was built for, a hand-edit followed immediately by
 * the next AI turn — which is also the shape of the original live bug.
 *
 * Best-effort / fail-open throughout: a field that can't be compared (no
 * prior AI baseline yet, or either side isn't parseable JSON) is never
 * flagged. This only ever adds a note; it must never block or corrupt the
 * actual response.
 */
export function detectOverwrittenHandEdits(
  current: Record<string, string | undefined | null>,
  aiBaseline: Record<string, unknown>,
  changes: Record<string, unknown>,
): string[] {
  const overwritten: string[] = []
  for (const key of Object.keys(changes)) {
    if (!(key in NARRATIVE_FIELD_LABELS)) continue
    if (!(key in aiBaseline)) continue // nothing to compare against yet
    const currentRaw = current[key]
    if (currentRaw == null || !currentRaw.trim()) continue
    const baselineValue = aiBaseline[key]

    if (key === 'intro_en' || key === 'intro_it') {
      const baselineText = String(baselineValue ?? '').trim()
      const currentText = currentRaw.trim()
      if (currentText === baselineText) continue // no hand edit at all
      const inserted = extractInsertedMiddle(baselineText, currentText).trim()
      const newText = String(changes[key] ?? '')
      if (inserted && newText.includes(inserted)) continue // preserved verbatim — not a loss
      overwritten.push(NARRATIVE_FIELD_LABELS[key])
      continue
    }
    let currentParsed: unknown
    try {
      currentParsed = JSON.parse(currentRaw)
    } catch {
      continue // hand-edited into invalid JSON — can't safely compare, don't guess
    }
    if (!deepEqual(currentParsed, baselineValue)) overwritten.push(NARRATIVE_FIELD_LABELS[key])
  }
  return overwritten
}
