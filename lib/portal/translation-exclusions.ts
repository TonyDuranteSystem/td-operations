/**
 * The portal's "never auto-translate this" registry — dev job 12cab351.
 *
 * Every entry below was found and verified by a Legal-Reviewer council pass
 * (2026-08-21), reading the actual file/wording in question, not assumed
 * from a category. This is a REGISTRY, not an enforcement mechanism by
 * itself — every future content-migration script (wizard-configs.ts, the
 * tax-form.ts dictionary, the scattered inline-ternary sweep) MUST consult
 * isExcludedFieldName() / EXCLUDED_MODULES before moving any content into
 * portal_translations. A migration script that doesn't check this file is
 * not safe to run, regardless of how it's otherwise built.
 *
 * Why this exists, in one line: the portal's client-facing text is safe to
 * machine-translate ONLY where a mistranslation would be an inconvenience,
 * never where it would be a mismatch between what a client agreed to and
 * what's on record as having been agreed to.
 */

/**
 * Field NAMES (from components/portal/wizard/wizard-configs.ts's FieldConfig
 * `name` property) that must never be auto-translated, regardless of which
 * wizard or which array they appear in. Matched by name, not by `type`,
 * because these are ordinary `type: 'checkbox'` fields structurally
 * identical to every other checkbox in the file — there is no type-level
 * signal that separates them, only the name.
 *
 * Confirmed by direct read (2026-08-21): every 'disclaimer_accepted' field
 * across all 9 wizards + the DB-driven brand-audit loader
 * (lib/td-communication/question-to-field.ts:32-35, which hardcodes the
 * same field rather than reading it from the database) uses this exact
 * name. 'prior_never_filed_declaration' is a second, distinct field with
 * the same character (a client's own attestation feeding a federal filing)
 * that does NOT share the name, so it needs its own entry.
 *
 * A field's `label`/`labelIt` AND, where present, `hint`/`hintIt` are both
 * covered — two of the ten (the Payset/Relay banking wizards) put the real
 * attestation wording in `hint`, with `label` being just the word
 * "Confirmation".
 */
export const EXCLUDED_WIZARD_FIELD_NAMES: readonly string[] = [
  "disclaimer_accepted",
  "prior_never_filed_declaration",
]

/**
 * A field's `warningOnValue` conditional text — attached to another field,
 * not a field of its own — that must also never be auto-translated.
 * Confirmed (2026-08-21): components/portal/wizard/wizard-configs.ts:376,
 * on `has_related_party_transactions` — states a real $25,000 IRS penalty
 * figure tied to a compliance question. Not an attestation, but the same
 * "a translation error here is a financial/legal misstatement" character.
 */
export const EXCLUDED_WIZARD_WARNING_FIELD_NAMES: readonly string[] = [
  "has_related_party_transactions",
]

/** True if a wizard field's name means its label/hint text must never be auto-translated. */
export function isExcludedFieldName(name: string): boolean {
  return EXCLUDED_WIZARD_FIELD_NAMES.includes(name)
}

/** True if a wizard field's warningOnValue text must never be auto-translated. */
export function isExcludedWarningFieldName(name: string): boolean {
  return EXCLUDED_WIZARD_WARNING_FIELD_NAMES.includes(name)
}

/**
 * Whole modules that must never be fed into any migration script or
 * auto-translation path, in full — not because of one string inside them,
 * but because their entire purpose IS legally-versioned or liability text.
 *
 *  - lib/td-communication/disclaimer.ts — hash-versioned disclaimer text
 *    (includes a stated $10,000 penalty clause); the acceptance record is
 *    keyed to a hash of the exact EN+IT wording. A machine translation
 *    would be shown to the client without matching what's on file as
 *    having been accepted — the evidentiary chain breaks.
 *  - lib/td-communication/showcase-consent.ts — hash-versioned consent for
 *    TD to publicly feature a client's brand/logo. Lower severity (the
 *    consent is unconditionally revocable regardless of wording), but a
 *    translation that overstates the grant is still a real exposure.
 */
export const EXCLUDED_MODULES: readonly string[] = [
  "lib/td-communication/disclaimer.ts",
  "lib/td-communication/showcase-consent.ts",
]

/**
 * Specific in-component text that must never be auto-translated, where the
 * text lives inline in a component rather than in a structured field list.
 * These aren't migrated by any script today (no current migration reaches
 * component JSX text at all), but are recorded here so that if a future
 * "translate everything" pass is ever built to scan raw JSX rather than
 * named content sources, it has to consult this list first.
 *
 *  - components/portal/tax-financials-review.tsx (~line 3576) — the "I
 *    confirm I've reviewed my Profit & Loss and Balance Sheet" attestation.
 *    Feeds a real IRS filing (via app/api/portal/tax-financials/attest).
 *    No content hash backs this one at all — a plain boolean is the only
 *    record, so there is no fallback detection if the displayed wording
 *    ever drifts from what was actually shown.
 *  - components/portal/team-manager.tsx (~line 152) — TD's own liability
 *    disclaimer to the client about team-member access ("we are not
 *    responsible for what your teammate can or cannot do..."). Currently
 *    has NO locale handling of any kind (English-only, not even part of
 *    today's EN/IT system) — zero existing protection against being swept
 *    into a future broad auto-translate pass.
 */
export const EXCLUDED_COMPONENT_TEXT: readonly { file: string; description: string }[] = [
  {
    file: "components/portal/tax-financials-review.tsx",
    description: "Client attestation confirming P&L/Balance Sheet numbers before they feed a real tax filing.",
  },
  {
    file: "components/portal/team-manager.tsx",
    description: "TD's own liability disclaimer about client team-member access.",
  },
]
