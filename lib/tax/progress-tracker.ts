/**
 * Tax Return progress tracker — pure stage-mapping logic (Slice 5, REV 4.1).
 *
 * Maps the catalog's Tax Return pipeline stages + the client's current SD
 * stage into the renderable tracker model: which steps are completed, which
 * is current, which are future.
 *
 * Catalog-driven: tracker membership = stages with a non-null client_label
 * (the 13 client-facing stages Slice 1 relabelled). Internal stages
 * (Company Data Pending, Paid - Awaiting Data, Data Received,
 * Terminated - Non Payment) have no client_label and never render.
 *
 * Rules (spec §5):
 *  - The tracker appears only once the client is at/past the first labelled
 *    stage (1st Installment Paid) — pre-installment and standalone-intake
 *    stages (negative/zero stage_order) show nothing.
 *  - "Current" = the labelled stage with the highest stage_order ≤ the SD's
 *    stage_order. This makes internal in-between stages (Data Received, 50)
 *    keep the previous labelled step highlighted ("Confirmed — being
 *    processed") instead of breaking the tracker.
 *  - Unknown / legacy stage names → no tracker (defensive, never crash).
 */

export interface TrackerCatalogStage {
  stage_name: string
  stage_order: number
  client_label: string | null
  client_label_it: string | null
  icon: string | null
}

export interface TrackerStep {
  /** Catalog stage_name (internal key) */
  stageName: string
  /** Display label resolved for the requested locale */
  label: string
  icon: string | null
  state: 'completed' | 'current' | 'future'
}

/**
 * The SD parks at "Data Submitted" (45) for the entire review loop — the
 * fine-grained position lives on tax_return_submissions.review_status. The
 * catalog stages 46-49 exist to represent those sub-states; this map overlays
 * review_status onto the tracker so the client's dot matches what the banner
 * says (e.g. banner "Reviewed — Confirm" ⇒ dot on "Approved", not stuck on
 * "Data Submitted"). Effective position = the FURTHER of (SD stage, mapped
 * review stage), so a stale review_status can never drag an advanced SD back.
 */
const REVIEW_STATUS_STAGE: Record<string, string> = {
  submitted: 'Data Submitted',
  resubmitted: 'Data Submitted',
  reopened: 'Data Submitted',
  under_review: 'Under Review',
  revision_requested: 'Revision Requested',
  approved: 'Approved',
  confirmed: 'Confirmed',
}

/**
 * Build the tracker steps, or null when the tracker must not render:
 *  - current SD stage unknown to the catalog (legacy/renamed stage string)
 *  - client not yet at the first labelled stage
 *  - client past the last labelled stage (terminated branch)
 */
export function buildTrackerSteps(
  catalogStages: TrackerCatalogStage[],
  currentStageName: string | null,
  locale: 'en' | 'it',
  reviewStatus?: string | null,
): TrackerStep[] | null {
  if (!currentStageName) return null

  let current = catalogStages.find(s => s.stage_name === currentStageName)
  if (!current) return null // legacy/unknown stage string — hide, don't guess

  // Overlay the review sub-state when it marks a further position.
  const mappedName = reviewStatus ? REVIEW_STATUS_STAGE[reviewStatus] : undefined
  if (mappedName) {
    const mapped = catalogStages.find(s => s.stage_name === mappedName)
    if (mapped && mapped.stage_order > current.stage_order) current = mapped
  }

  const labelled = catalogStages
    .filter(s => s.client_label !== null)
    .sort((a, b) => a.stage_order - b.stage_order)
  if (labelled.length === 0) return null

  const firstOrder = labelled[0].stage_order
  const lastOrder = labelled[labelled.length - 1].stage_order

  // Pre-installment (standalone intake / not started) — no tracker yet.
  if (current.stage_order < firstOrder) return null
  // Past the last labelled stage (Terminated - Non Payment, 90) — no tracker.
  if (current.stage_order > lastOrder) return null

  // Current marker = highest labelled stage at or below the SD's order, so
  // internal in-between stages (Data Received, 50) keep the previous
  // labelled step highlighted.
  let currentIdx = -1
  for (let i = 0; i < labelled.length; i++) {
    if (labelled[i].stage_order <= current.stage_order) currentIdx = i
  }
  if (currentIdx === -1) return null // unreachable given the gate above; defensive

  return labelled.map((s, i) => ({
    stageName: s.stage_name,
    label:
      (locale === 'it' ? s.client_label_it : null) ?? s.client_label ?? s.stage_name,
    icon: s.icon,
    state: i < currentIdx ? 'completed' : i === currentIdx ? 'current' : 'future',
  }))
}
