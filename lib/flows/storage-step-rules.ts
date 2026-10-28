/**
 * "A workspace step is waiting for this document" — the RULES (dev job e3215801). Pure: no database, no server imports, so the Storage
 * page can use it in the browser to skip the check for ordinary files, and the server uses the very same table.
 *
 * Real incident (2026-10-23, Adam Mihaly): staff filed his IRS ITIN letter straight into Storage, hidden from the client, instead of
 * uploading it in the ITIN workspace. The workspace step reads the letter, saves the ITIN on the contact, shows the letter to the
 * client, tells the client and closes the case; a plain Storage save does none of that, so the case sat open and the client saw nothing.
 *
 * Only the table below says what each step waits for; ITIN first (Antonio), other services are one row each.
 */

export interface StorageStepHint {
  serviceType: string
  /** The stages of an OPEN case at which a matching file means "the workspace is waiting for this". */
  stages: string[]
  /** Storage document types (catalog slugs) that count. */
  documentTypes: string[]
  /** `documentTypes` holds a GENERIC type (e.g. "receipt"): it only counts inside a folder of `folderKind` — a receipt anywhere else is just a receipt. */
  typeNeedsFolder?: boolean
  /** A file saved into this KIND of folder with one of `vagueTypes` (or with no type) also counts — a file typed "Other document". */
  folderKind?: string
  vagueTypes?: string[]
  /** Plain words: the document the step asks for ("the IRS approval letter (CP565)"). */
  asks: string
  /** What to do in the workspace at each stage — the exact buttons and boxes staff see there (read from the live ITIN pipeline, 2026-10-27). */
  howByStage: Record<string, string>
  /** What the workspace step does that a Storage save does NOT (shown as "It will NOT: …"). Only things that are verified. */
  workspaceDoes: string[]
  /** A bullet of `workspaceDoes` that Storage ALSO does for these document types: it moves from "will not" to "Storage will:". */
  storageAlsoDoes?: Array<{ types: string[]; does: string; storage: string }>
}

/**
 * Order matters when two rows could match one case: the first wins. The mailing receipt (its own stage only) comes before the letter,
 * which also covers "Submitted to IRS" because an approval can arrive before the case is moved on.
 * Verified against: app/api/flows/[id]/upload-document/route.ts (isItinApprovalUpload — only at "ITIN Approved"), lib/itin/finalize-approval.ts,
 * lib/crm-store/browse.ts (a Storage save typed itin_letter reads the ITIN itself), and the live ITIN stage layouts: "Shipped" and
 * "IRS Processing" have NO upload box; "Documents Received" has the package scan box; "Submitted to IRS" the mailing receipt box;
 * "ITIN Approved" the CP565 letter box.
 */
export const STORAGE_STEP_HINTS: readonly StorageStepHint[] = [
  {
    serviceType: 'ITIN',
    stages: ['Shipped', 'Documents Received'],
    documentTypes: ['itin_application', 'form_w_7'],
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the signed package received from the client',
    howByStage: {
      Shipped: 'Press "Documents Received at Office" first, then upload the scan in the "Upload received package scan" box.',
      'Documents Received': 'Upload the scan in the "Upload received package scan" box.',
    },
    workspaceDoes: ['attach it to the case as the received package', 'move the case on to the CAA review'],
  },
  {
    serviceType: 'ITIN',
    stages: ['Submitted to IRS'],
    documentTypes: ['receipt'],
    typeNeedsFolder: true,
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the mailing receipt for the package sent to the IRS',
    howByStage: {
      'Submitted to IRS': 'Upload it in the "Upload mailing receipt/tracking" box.',
    },
    workspaceDoes: ['attach it to the case as the mailing receipt'],
  },
  {
    serviceType: 'ITIN',
    stages: ['Submitted to IRS', 'IRS Processing', 'ITIN Approved'],
    documentTypes: ['itin_letter', 'itin_cp565', 'itin_letter_client_received'],
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the IRS approval letter (CP565)',
    howByStage: {
      'Submitted to IRS':
        'Press "Submitted - Wait for IRS", then "ITIN Received", then upload the letter in the "Upload CP565 ITIN Letter" box. Do not use the mailing-receipt box you see now — it is for the receipt, not the letter.',
      'IRS Processing': 'Press "ITIN Received" first, then upload the letter in the "Upload CP565 ITIN Letter" box.',
      'ITIN Approved': 'Upload the letter in the "Upload CP565 ITIN Letter" box.',
    },
    workspaceDoes: [
      'read the ITIN from the letter and save it on the contact',
      'show the letter to the client',
      'tell the client (message, notification and email)',
      'close the case',
    ],
    // a Storage save typed "ITIN Letter" reads the letter itself (lib/crm-store/browse.ts, readIdentityIntoContact) — the other letter types do not
    storageAlsoDoes: [
      {
        types: ['itin_letter'],
        does: 'read the ITIN from the letter and save it on the contact',
        storage: 'try to read the ITIN number off the letter and save it on the contact',
      },
    ],
  },
]

/** Statuses of a case that is finished: nothing is waiting any more. */
const FINISHED_STATUSES = ['completed', 'cancelled']

export interface OpenCase {
  sdId: string
  serviceType: string
  stage: string
  status: string
}

export interface WaitingWorkspaceStep {
  sdId: string
  serviceType: string
  stage: string
  /** The person or company the case belongs to ("Adam Mihaly"). */
  who: string
  asks: string
  /** "type": the file's document type is the one the step asks for. "folder": it is typed "Other document" (or untyped) in the ITIN folder — it MAY be that document. */
  matchedBy: 'type' | 'folder'
  /** What to do in the workspace at this stage (the buttons and boxes to use). */
  how: string
  /** What a Storage save itself does for this file (so the pop-up never claims otherwise). */
  storageDoes: string[]
  /** What only the workspace step does. */
  workspaceDoes: string[]
  /** Where the workspace is. */
  workspacePath: string
  /** The case's own person / company, so the record of a Storage-only filing shows on THEIR activity too. */
  contactId: string | null
  accountId: string | null
}

/** Could a file of this type EVER make a row match? A cheap test (no database) so an ordinary upload is not even sent to the check. */
export function typeCouldWait(documentType: string | null): boolean {
  if (documentType === null) return true
  return STORAGE_STEP_HINTS.some((h) => h.documentTypes.indexOf(documentType) !== -1 || (h.vagueTypes ?? []).indexOf(documentType) !== -1)
}

/** Could ANY hint ever match this type going into this kind of folder? */
export function couldMatchAnyHint(documentType: string | null, folderKind: string | null): boolean {
  return STORAGE_STEP_HINTS.some(
    (h) =>
      (documentType !== null && h.documentTypes.indexOf(documentType) !== -1 && (!h.typeNeedsFolder || (folderKind !== null && h.folderKind === folderKind))) ||
      (folderKind !== null && h.folderKind === folderKind && (documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1)),
  )
}

function hintFor(
  c: OpenCase,
  documentType: string | null,
  folderKind: string | null,
): { hint: StorageStepHint; by: 'type' | 'folder' } | null {
  if (FINISHED_STATUSES.indexOf(c.status) !== -1) return null
  for (let i = 0; i < STORAGE_STEP_HINTS.length; i++) {
    const h = STORAGE_STEP_HINTS[i]
    if (h.serviceType !== c.serviceType || h.stages.indexOf(c.stage) === -1) continue
    if (documentType !== null && h.documentTypes.indexOf(documentType) !== -1 && (!h.typeNeedsFolder || (folderKind !== null && h.folderKind === folderKind))) {
      return { hint: h, by: 'type' }
    }
    const vague = documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1
    if (vague && h.folderKind && folderKind === h.folderKind) return { hint: h, by: 'folder' }
  }
  return null
}

/** Pure: which of these open cases is waiting for a file of this type, going into this kind of folder? */
export function matchStorageStepHints(input: {
  cases: Array<OpenCase & { who: string; contactId?: string | null; accountId?: string | null }>
  documentType: string | null
  folderKind: string | null
}): WaitingWorkspaceStep[] {
  const out: WaitingWorkspaceStep[] = []
  for (let i = 0; i < input.cases.length; i++) {
    const c = input.cases[i]
    const m = hintFor(c, input.documentType, input.folderKind)
    if (!m) continue
    const also = (m.hint.storageAlsoDoes ?? []).filter((a) => input.documentType !== null && a.types.indexOf(input.documentType) !== -1)
    out.push({
      sdId: c.sdId,
      serviceType: c.serviceType,
      stage: c.stage,
      who: c.who,
      asks: m.hint.asks,
      matchedBy: m.by,
      how: m.hint.howByStage[c.stage] ?? '',
      storageDoes: also.map((a) => a.storage),
      workspaceDoes: m.hint.workspaceDoes.filter((w) => !also.some((a) => a.does === w)),
      workspacePath: `/flows/${c.sdId}`,
      contactId: c.contactId ?? null,
      accountId: c.accountId ?? null,
    })
  }
  return out
}
