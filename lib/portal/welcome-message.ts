/**
 * Catalog-driven welcome message resolver.
 *
 * Bilingual portal-chat templates sent automatically when a client activates a
 * service. Templates live in `catalog_entries WHERE catalog_id='welcome_messages'`
 * and are editable from the CRM `/catalog` page without a deploy.
 *
 * Selection algorithm (one combined message per offer, NOT one per service):
 *   1. Map each pipeline name (display name in `offers.bundled_pipelines`) to a
 *      catalog slug via PIPELINE_TO_WELCOME_SLUG.
 *   2. If pipelines is empty, fall back to the contract_type → slug mapping
 *      (CONTRACT_TYPE_TO_WELCOME_SLUG) so onboarding/formation offers whose SD
 *      is created by the wizard (not at payment) still get a welcome.
 *   3. Fetch every matching catalog entry from the welcome_messages catalog.
 *   4. Pick the one with the highest `metadata.priority` (descending). Ties
 *      fall back to slug-alphabetical order so the result is deterministic.
 *   5. Render the title and body in the requested language; missing IT
 *      translation falls back to the English `display_name` / `description`.
 *   6. Return `null` if no template matches — caller falls back to the legacy
 *      generic copy.
 *
 * Spec: PR D of sysdoc `ops-2026-05-13-bank-feed-realtime-plan`.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

const WELCOME_MESSAGES_CATALOG_ID = "welcome_messages" as const

/**
 * Map pipeline display name (as stored in `offers.bundled_pipelines`) to the
 * `welcome_messages` catalog slug to look up. Mirrors the values produced by
 * `lib/services/index.ts::SERVICE_TYPE_TO_SLUG` but only for service types that
 * trigger a post-payment welcome — bundled-renewal SDs (CMRA, State Annual
 * Report, State RA Renewal, Annual Renewal) intentionally have no welcome
 * (they're recurring management work, not new-client onboarding).
 *
 * Add a row here AND a `catalog_entries` row in the welcome_messages migration
 * when introducing a new welcomable service type.
 */
const PIPELINE_TO_WELCOME_SLUG: Record<string, string> = {
  "Tax Return": "tax_return",
  "Tax Return One-Time": "tax_return",
  "Company Formation": "company_formation",
  EIN: "ein",
  ITIN: "itin",
  "Banking Fintech": "banking",
  "Banking Physical": "banking_physical",
  "Client Onboarding": "client_onboarding",
  "Company Closure": "closure",
}

/**
 * Fallback when `offers.bundled_pipelines` is empty. Onboarding and formation
 * offers often have no pipeline at activation time (the SD is created later by
 * the wizard), so without this fallback they'd silently fall back to the
 * legacy generic copy.
 */
const CONTRACT_TYPE_TO_WELCOME_SLUG: Record<string, string> = {
  formation: "company_formation",
  onboarding: "client_onboarding",
  tax_return: "tax_return",
}

export interface WelcomeMessageTemplate {
  slug: string
  title: string
  body: string
  language: "en" | "it"
  priority: number
  wizardPath?: string | null
}

export interface WelcomeMessageVars {
  firstName?: string
  lastName?: string
  companyName?: string
  serviceName?: string
  wizardUrl?: string
}

/**
 * Replace `{{placeholder}}` tokens with values from `vars`. Unknown placeholders
 * are LEFT IN PLACE (visible in the output) so missing data is obvious during
 * QA rather than silently swallowed. Whitespace inside the braces is not
 * tolerated — templates must use the exact form `{{key}}`.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key]
    return value !== undefined && value !== null && value !== "" ? value : `{{${key}}}`
  })
}

interface WelcomeMessageRow {
  slug: string
  display_name: string
  display_name_translations: Record<string, string> | null
  description: string | null
  description_translations: Record<string, string> | null
  status: string
  metadata: Record<string, unknown> | null
}

function pickPriority(metadata: Record<string, unknown> | null | undefined): number {
  if (!metadata) return 0
  const p = (metadata as { priority?: unknown }).priority
  return typeof p === "number" && Number.isFinite(p) ? p : 0
}

function pickWizardPath(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null
  const w = (metadata as { wizard_path?: unknown }).wizard_path
  return typeof w === "string" && w.length > 0 ? w : null
}

/**
 * Resolve the welcome message template for an activation. Returns `null` when
 * no template matches so the caller can fall back to the legacy generic copy.
 */
export async function getWelcomeMessage(opts: {
  contractType: string
  pipelines: string[]
  language: string | null | undefined
}): Promise<WelcomeMessageTemplate | null> {
  const lang: "en" | "it" =
    opts.language === "it" || opts.language === "Italian" ? "it" : "en"

  // Resolve candidate slugs.
  const slugs = new Set<string>()
  for (const p of opts.pipelines || []) {
    const slug = PIPELINE_TO_WELCOME_SLUG[p]
    if (slug) slugs.add(slug)
  }
  if (slugs.size === 0) {
    const fallback = CONTRACT_TYPE_TO_WELCOME_SLUG[opts.contractType]
    if (fallback) slugs.add(fallback)
  }
  if (slugs.size === 0) return null

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select(
      "slug, display_name, display_name_translations, description, description_translations, status, metadata",
    )
    .eq("catalog_id", WELCOME_MESSAGES_CATALOG_ID)
    .in("slug", Array.from(slugs))
    .neq("status", "deprecated")

  if (error) {
    console.error("[welcome-message] catalog read failed:", error.message)
    return null
  }
  if (!data || data.length === 0) return null

  // Pick highest priority; tiebreak alphabetical by slug for determinism.
  const rows = (data as WelcomeMessageRow[]).slice().sort((a, b) => {
    const pa = pickPriority(a.metadata)
    const pb = pickPriority(b.metadata)
    if (pb !== pa) return pb - pa
    return a.slug.localeCompare(b.slug)
  })
  const winner = rows[0]

  const titleIt = winner.display_name_translations?.it
  const bodyIt = winner.description_translations?.it
  const title = lang === "it" && titleIt ? titleIt : winner.display_name
  const body = lang === "it" && bodyIt ? bodyIt : winner.description ?? ""

  return {
    slug: winner.slug,
    title,
    body,
    language: lang,
    priority: pickPriority(winner.metadata),
    wizardPath: pickWizardPath(winner.metadata),
  }
}
