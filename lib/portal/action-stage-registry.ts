/**
 * Registry of pipeline stages that REQUIRE a client action on entry —
 * Phase C of the Client Action-Required system (Phase A: action-required.ts).
 *
 * When advanceServiceDelivery lands an SD on a registered stage, it dispatches
 * the full action-required package (clickable chat + immediate email +
 * bell/push, see notifyClientActionRequired) INSTEAD of the generic
 * "status updated" notification + the notify_client_email stage email — one
 * message, three channels, never doubles.
 *
 * Deliberately CODE-side (not pipeline_stages columns): zero DDL, unit-tested,
 * copy reviewed in PRs. If Antonio later wants CRM-editable copy, this moves
 * to catalog columns — the dispatch seam in service-delivery.ts stays the same.
 */

import type { LocalizedText } from './action-required'

export interface ActionStageConfig {
  title: LocalizedText
  message: LocalizedText
  /** Portal-relative action path. Supports the `{sd_id}` token, replaced with
   * the service-delivery id by the dispatch block in service-delivery.ts. */
  link: string
}

/** Key: `${service_type}::${stage_name}` (both exact, case-sensitive). */
const ACTION_STAGES: Record<string, ActionStageConfig> = {
  // The client must fill the tax wizard. Replaces (not stacks on) the stage's
  // notify_client_email email + generic bell for this transition.
  'Tax Return::Wizard Available': {
    title: {
      en: 'Complete your tax form',
      it: 'Compila il tuo modulo fiscale',
    },
    message: {
      en: 'It’s time to submit your tax information. Please open your portal and complete the tax form — we can’t prepare your return without it.',
      it: 'È il momento di inviarci le informazioni fiscali. Accedi al portale e compila il modulo — senza non possiamo preparare la tua dichiarazione.',
    },
    link: '/portal/wizard',
  },
  // The client must print, wet-ink sign, and mail the ITIN package. Migrated
  // from the bespoke 8c block in service-delivery.ts (2026-06-25) onto the
  // shared rail — copy preserved verbatim.
  'ITIN::Client Signing': {
    title: {
      en: 'Print, sign & mail your ITIN documents',
      it: 'Stampa, firma e spedisci i documenti ITIN',
    },
    message: {
      en: 'Your ITIN documents are ready in your portal. Please print them, sign with wet ink, include two color copies of your passport, and mail everything to our office. You’ll find the complete instructions and mailing address in your portal.',
      it: 'I tuoi documenti ITIN sono pronti nel portale. Per favore stampali, firmali a inchiostro (firma originale), includi due copie a colori del passaporto e spedisci tutto al nostro ufficio. Troverai le istruzioni complete e l’indirizzo di spedizione nel tuo portale.',
    },
    // The flow detail page: prepared documents + TD mailing address +
    // print/sign/mail checklist + the shipping-tracking form.
    link: '/portal/flows/{sd_id}',
  },
}

/** Config for a stage the client must act on, or null for ordinary stages. */
export function actionStageConfigFor(
  serviceType: string | null | undefined,
  stageName: string | null | undefined,
): ActionStageConfig | null {
  if (!serviceType || !stageName) return null
  return ACTION_STAGES[`${serviceType}::${stageName}`] ?? null
}
