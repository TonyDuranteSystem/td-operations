/**
 * The EIN closure PACKAGE for a Company Closure job (dev job a6bbea09): the letter to the IRS (lib/closure/ein-closure-letter.ts) with a copy
 * of the company's EIN notice merged behind it, saved on the job — what staff print and mail in the "IRS Closure" step.
 *
 * Two jobs here, both server-side:
 *   - `loadEinClosureFacts(jobId)` — everything the panel shows and the letter needs, read from the job, the client's closure wizard and the
 *     documents: the company's name / EIN / state, who signs, the company address (when we know it), the copies of the EIN notice on file,
 *     and the letter already made (if any).
 *   - `buildEinClosurePackage(...)` — makes the PDF, merges the chosen notice, saves it in the company's storage (or the person's, for a job
 *     with no company record) as an "EIN Cancellation Request", and lists it on the job.
 *
 * Rules that matter (each one is a way this could go wrong):
 *   - A closure job with NO company record (the client closes an LLC we never had) takes the company's facts from what the client wrote in
 *     the wizard; a job WITH a company takes them from our record (the wizard is the client's typing — it may name another company).
 *   - The copy of the EIN notice is only ever one of the files THIS job (or this job's company) has. A person-scoped job never offers the
 *     person's other documents: a client can own several companies, each with its own EIN letter, and the wrong one would go to the IRS.
 *   - The saved PDF is never returned to the browser (a response over 4.5 MB is cut by the host); it is saved here and opened from the
 *     documents list.
 *   - Nothing is sent anywhere. Staff print it and mail it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { pickClosureAnswers } from '@/lib/flows/closure-answers'
import { buildEinClosureLetterPdf, einClosureLetterProblems } from '@/lib/closure/ein-closure-letter'
import { parseStorePointer } from '@/lib/crm-store/document-pointer'
import { looksLikePng, MAX_SIGNATURE_BYTES } from '@/lib/closure/signature-consent'
import { TD_LARGO_STREET_3D, TD_LARGO_CITY, TD_LARGO_STATE, TD_LARGO_ZIP } from '@/lib/addresses'

/** The saved package's file name and the key that makes "Generate again" a NEW VERSION of the same file, never a second file. */
export const EIN_PACKAGE_DOC_TYPE = 'ein_cancellation_request'
export const einPackageName = (companyName: string): string => `EIN Closure Letter - ${companyName.replace(/[\\/\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()}.pdf`
export const einPackageCallerKey = (jobId: string): string => `ein-closure-letter:${jobId}`

export interface EinNoticeCandidate {
  documentId: string
  name: string
  typeLabel: string | null
  /** the stored file behind it (a Google-Drive-only pointer cannot be merged) */
  storeFileId: string | null
  /** PDF, PNG or JPG — what the merge can read (a phone HEIC photo cannot) */
  mergeable: boolean
  /** the one the client uploaded in the wizard, or the only EIN notice on file */
  recommended: boolean
}

export interface EinClosureFacts {
  jobId: string
  stage: string | null
  hasCompany: boolean
  companyName: string
  ein: string
  state: string | null
  signerName: string
  /** the company's address, prefilled when we know it ('suite' = our official Largo address, a company that has a TD suite) */
  addressLines: string[]
  addressSource: 'suite' | 'account' | 'none'
  /** what the client answered: "Yes" / "No" / null */
  returnsFiled: string | null
  notices: EinNoticeCandidate[]
  /** the client's drawn signature is on file AND the wizard recorded their consent (the closure wizard box, lib/closure/signature-consent.ts) */
  hasSignature: boolean
  /** when the client signed (the server's clock, from the consent record) */
  signedAt: string | null
  /** the stored picture of the signature (internal: read when the letter is made) */
  signatureStoreFileId: string | null
  existingLetter: { documentId: string; name: string; createdAt: string } | null
  /** plain sentences for staff: things to look at before printing */
  warnings: string[]
}

export type EinFactsResult = { ok: true; facts: EinClosureFacts } | { ok: false; error: string; status: number }

const MERGEABLE_EXT = /\.(pdf|png|jpe?g)$/i

/** True for a failed result. (A plain `!r.ok` does not narrow these unions under this project's compiler settings; a type guard does.) */
export function isFail<T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> {
  return r.ok === false
}

/** Is this stored file the company's EIN notice (CP 575 / 147C / "EIN letter") — and not our own closure letter or the IRS's closure answer? */
export function isEinNoticeCandidate(fileName: string, typeLabel: string | null): boolean {
  const name = fileName.trim()
  if (/^EIN Closure Letter/i.test(name)) return false // our own package
  const type = (typeLabel ?? '').trim()
  if (/cancel/i.test(type) || /closure|cancel/i.test(name)) return false // a cancellation request / the IRS's answer, not the notice
  if (/^EIN\b/i.test(type)) return true // "EIN IRS FAX - LTR 147C", "EIN Letter (IRS)", "EIN CP575B"…
  return /^ein[_ -]?letter/i.test(name) || /(cp[ _-]?575|147c)/i.test(name) // the wizard's field name prefix, or the IRS form number
}

/** Staff type an address in a box: one line per row, at most 4 lines of at most 80 characters. */
export function splitAddress(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4).map((l) => l.slice(0, 80))
}

/** "Christian Ranieri" from the wizard's answers — the owner's own fields first, then the first/last name the client signed in with. */
export function signerFromAnswers(a: Record<string, unknown> | null | undefined): string {
  const s = (k: string) => (typeof a?.[k] === 'string' ? (a[k] as string).trim() : '')
  const owner = `${s('owner_first_name')} ${s('owner_last_name')}`.trim()
  return owner || `${s('first_name')} ${s('last_name')}`.trim()
}

interface JobRow {
  id: string
  service_type: string | null
  stage: string | null
  status: string | null
  account_id: string | null
  contact_id: string | null
  created_at: string
  source_closure_token: string | null
}

async function loadJob(jobId: string): Promise<{ ok: true; job: JobRow } | { ok: false; error: string; status: number }> {
  const { data, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, stage, status, account_id, contact_id, created_at, source_closure_token')
    .eq('id', jobId)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not read the job: ${error.message}`, status: 500 }
  if (!data) return { ok: false, error: 'Job not found.', status: 404 }
  if ((data as JobRow).service_type !== 'Company Closure') return { ok: false, error: 'This is not a Company Closure job.', status: 400 }
  return { ok: true, job: data as JobRow }
}

/** The wizard answers that belong to THIS job — the same rule as the workspace's "Closure wizard answers" box (lib/flows/closure-answers.ts). */
async function loadAnswers(job: JobRow): Promise<{ ok: true; answers: Record<string, unknown> | null } | { ok: false; error: string }> {
  if (!job.account_id && !job.contact_id) return { ok: true, answers: null }
  let q = supabaseAdmin.from('closure_submissions').select('submitted_data, status, completed_at, created_at, token').in('status', ['completed', 'reviewed'])
  let others = supabaseAdmin.from('service_deliveries').select('id').eq('service_type', 'Company Closure').eq('status', 'active').neq('id', job.id)
  if (job.account_id) {
    q = q.eq('account_id', job.account_id)
    others = others.eq('account_id', job.account_id)
  } else {
    q = q.eq('contact_id', job.contact_id as string).is('account_id', null)
    others = others.eq('contact_id', job.contact_id as string).is('account_id', null)
  }
  const [{ data: rows, error: e1 }, { data: otherJobs, error: e2 }] = await Promise.all([q.order('created_at', { ascending: false }).limit(50), others])
  if (e1 || e2) return { ok: false, error: `Could not read the closure wizard: ${(e1 ?? e2)?.message}` }
  const picked = pickClosureAnswers({
    job: { id: job.id, created_at: job.created_at, source_closure_token: job.source_closure_token },
    rows: rows ?? [],
    otherOpenJobs: (otherJobs ?? []).map((o: { id: string }) => ({ id: o.id })),
  })
  return { ok: true, answers: (picked?.submitted_data as Record<string, unknown> | null) ?? null }
}

export async function loadEinClosureFacts(jobId: string): Promise<EinFactsResult> {
  const j = await loadJob(jobId)
  if (isFail(j)) return j
  const job = j.job
  const warnings: string[] = []

  const a = await loadAnswers(job)
  if (isFail(a)) return { ok: false, error: a.error, status: 500 }
  const answers = a.answers
  const str = (k: string) => (typeof answers?.[k] === 'string' ? (answers[k] as string).trim() : '')

  // the company: our record when the job has one, else what the client wrote
  let companyName = str('llc_name')
  let ein = str('llc_ein')
  let state: string | null = str('llc_state') || null
  let addressLines: string[] = []
  let addressSource: EinClosureFacts['addressSource'] = 'none'
  if (job.account_id) {
    const { data: acc, error } = await supabaseAdmin.from('accounts').select('company_name, ein_number, state_of_formation, physical_address').eq('id', job.account_id).maybeSingle()
    if (error) return { ok: false, error: `Could not read the company: ${error.message}`, status: 500 }
    if (acc) {
      const wizardName = companyName
      companyName = (acc.company_name as string | null) ?? companyName
      ein = (acc.ein_number as string | null) ?? ein
      state = (acc.state_of_formation as string | null) ?? state
      if (wizardName && companyName && wizardName.toLowerCase() !== companyName.toLowerCase()) {
        warnings.push(`The client wrote "${wizardName}" in the wizard, but this job is for "${companyName}". The letter uses ${companyName}.`)
      }
      const { companyCmraAddressLine } = await import('@/lib/operations/suite')
      let hasSuite = false
      try {
        hasSuite = (await companyCmraAddressLine(job.account_id, null)) !== null
      } catch (e) {
        return { ok: false, error: `Could not read the company's address: ${e instanceof Error ? e.message : String(e)}`, status: 500 }
      }
      if (hasSuite) {
        addressLines = [TD_LARGO_STREET_3D, `${TD_LARGO_CITY}, ${TD_LARGO_STATE} ${TD_LARGO_ZIP}`]
        addressSource = 'suite'
      } else if (typeof acc.physical_address === 'string' && acc.physical_address.trim()) {
        addressLines = acc.physical_address.split(/,\s*|\r?\n/).map((l: string) => l.trim()).filter(Boolean).slice(0, 4)
        addressSource = 'account'
      }
    }
  }

  // who signs: the owner the client named, else the person on the job
  let signerName = signerFromAnswers(answers)
  if (!signerName && job.contact_id) {
    const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', job.contact_id).maybeSingle()
    signerName = ((c as { full_name?: string | null } | null)?.full_name ?? '').trim()
  }

  // the copies of the EIN notice on file: only this job's files (and, for a job with a company, that company's)
  const byJob = await supabaseAdmin.from('documents').select('id, file_name, document_type_name, drive_file_id, created_at').eq('service_delivery_id', job.id)
  const byAccount = job.account_id
    ? await supabaseAdmin.from('documents').select('id, file_name, document_type_name, drive_file_id, created_at').eq('account_id', job.account_id)
    : { data: [] as never[], error: null }
  if (byJob.error || byAccount.error) return { ok: false, error: `Could not read the documents: ${(byJob.error ?? byAccount.error)?.message}`, status: 500 }
  type Doc = { id: string; file_name: string; document_type_name: string | null; drive_file_id: string | null; created_at: string }
  const seen = new Set<string>()
  const docs: Doc[] = []
  for (const d of [...((byJob.data ?? []) as Doc[]), ...((byAccount.data ?? []) as Doc[])]) {
    if (!seen.has(d.id)) { seen.add(d.id); docs.push(d) }
  }
  docs.sort((x, y) => y.created_at.localeCompare(x.created_at))

  const noticeDocs = docs.filter((d) => isEinNoticeCandidate(d.file_name, d.document_type_name)).slice(0, 12)
  const notices: EinNoticeCandidate[] = noticeDocs.map((d) => ({
    documentId: d.id,
    name: d.file_name,
    typeLabel: d.document_type_name,
    storeFileId: parseStorePointer(d.drive_file_id),
    mergeable: MERGEABLE_EXT.test(d.file_name),
    recommended: false,
  }))
  // the wizard keeps the field name in the file name ("ein_letter_…"): that is the file the client uploaded for this closure
  const wizardOne = notices.find((n) => /^ein[_ -]?letter/i.test(n.name))
  if (wizardOne) wizardOne.recommended = true
  else if (notices.length === 1) notices[0].recommended = true

  // the client's drawn signature: the file the wizard filed under the field `signature_image` AND the consent record the SERVER wrote for it
  // (a file with that name but no consent record — staff uploaded it, or a client forged the answers — is never put on the letter)
  const sigDoc = docs.find((d) => /^signature_image/i.test(d.file_name))
  const sigFileId = sigDoc ? parseStorePointer(sigDoc.drive_file_id) : null
  const signedAt = str('signature_signed_at') || null
  const hasConsent = !!signedAt && !!str('signature_consent')
  if (sigDoc && !hasConsent) warnings.push("A signature picture is on this job but the client's consent was not recorded, so it is NOT used — the letter has a line to sign by hand.")
  if (sigDoc && hasConsent && !sigFileId) warnings.push("The client's signature picture is not in the new storage, so it cannot be used — the letter has a line to sign by hand.")
  const usableSignature = !!sigFileId && hasConsent

  const existing = docs.find((d) => /^EIN Closure Letter/i.test(d.file_name))
  if (notices.length === 0) warnings.push('No copy of the EIN letter is on this job. The IRS asks for one if the client still has it — the letter can go without it.')
  if (notices.some((n) => !n.mergeable)) warnings.push('One of the EIN letter files is not a PDF or a picture the system can join (for example a phone HEIC photo) — it cannot be attached.')
  const returnsFiled = str('tax_returns_filed') || null
  if (returnsFiled && returnsFiled.toLowerCase() !== 'yes') {
    warnings.push('The client says tax returns were NOT all filed. The IRS will not close the account until every return is filed and taxes are paid — a final return may be needed before this letter goes.')
  }

  return {
    ok: true,
    facts: {
      jobId: job.id,
      stage: job.stage,
      hasCompany: !!job.account_id,
      companyName,
      ein,
      state,
      signerName,
      addressLines,
      addressSource,
      returnsFiled,
      notices,
      hasSignature: usableSignature,
      signedAt: usableSignature ? signedAt : null,
      signatureStoreFileId: usableSignature ? sigFileId : null,
      existingLetter: existing ? { documentId: existing.id, name: existing.file_name, createdAt: existing.created_at } : null,
      warnings,
    },
  }
}

export interface BuildPackageInput {
  jobId: string
  /** the company address, as staff confirmed it (one line per entry) */
  addressLines: string[]
  /** the EIN notice to attach — one of the job's own candidates, or null for none */
  noticeDocumentId: string | null
  now?: Date
}

export type BuildPackageResult =
  | { ok: true; documentId: string; name: string; pages: number; attachedNotice: string | null; signed: boolean; warnings: string[] }
  | { ok: false; error: string; status: number }

export async function buildEinClosurePackage(input: BuildPackageInput): Promise<BuildPackageResult> {
  const f = await loadEinClosureFacts(input.jobId)
  if (isFail(f)) return f
  const facts = f.facts

  const problems = einClosureLetterProblems({ companyName: facts.companyName, ein: facts.ein, companyAddressLines: input.addressLines, signerName: facts.signerName })
  if (problems.length > 0) return { ok: false, error: problems.join(' '), status: 400 }

  let notice: EinNoticeCandidate | null = null
  if (input.noticeDocumentId) {
    notice = facts.notices.find((n) => n.documentId === input.noticeDocumentId) ?? null
    if (!notice) return { ok: false, error: "That EIN letter is not one of this job's files.", status: 400 }
    if (!notice.storeFileId) return { ok: false, error: 'That EIN letter is not in the new storage, so it cannot be attached. Upload it to the job first.', status: 400 }
    if (!notice.mergeable) return { ok: false, error: 'That EIN letter is not a PDF or a picture (PNG / JPG) — convert it first, then upload it again.', status: 400 }
  }

  // the client's drawn signature, when they drew one and consented: a real, small PNG only — anything else leaves the line to sign by hand
  let signaturePng: Uint8Array | null = null
  const warnings = [...facts.warnings]
  if (facts.signatureStoreFileId) {
    try {
      const { readStoreFile } = await import('@/lib/crm-store/document-pointer')
      const sig = await readStoreFile(facts.signatureStoreFileId)
      if (sig.bytes.length <= MAX_SIGNATURE_BYTES && looksLikePng(sig.bytes)) signaturePng = new Uint8Array(sig.bytes)
      else warnings.push("The client's signature file is not a usable PNG picture, so the letter has a line to sign by hand.")
    } catch (e) {
      warnings.push(`The client's signature could not be read (${e instanceof Error ? e.message : String(e)}), so the letter has a line to sign by hand.`)
    }
  }

  let letter: Uint8Array
  try {
    letter = await buildEinClosureLetterPdf({
      companyName: facts.companyName,
      ein: facts.ein,
      companyAddressLines: input.addressLines,
      signerName: facts.signerName,
      date: input.now ?? new Date(),
      includesEinNotice: !!notice,
      signaturePng,
    })
  } catch (e) {
    return { ok: false, error: `Could not make the letter: ${e instanceof Error ? e.message : String(e)}`, status: 400 }
  }

  let bytes = letter
  let pages = 1
  if (notice) {
    try {
      const { readStoreFile } = await import('@/lib/crm-store/document-pointer')
      const { mergeParts } = await import('@/lib/crm-store/merge-parts')
      const file = await readStoreFile(notice.storeFileId as string)
      const merged = await mergeParts([
        { name: 'EIN closure letter.pdf', mimeType: 'application/pdf', bytes: letter },
        { name: file.name, mimeType: file.mimeType, bytes: file.bytes },
      ])
      bytes = merged.bytes
      pages = merged.pageCounts.reduce((s, n) => s + n, 0)
    } catch (e) {
      return { ok: false, error: `The copy of the EIN letter could not be attached: ${e instanceof Error ? e.message : String(e)}`, status: 400 }
    }
  }

  const name = einPackageName(facts.companyName)
  const callerKey = einPackageCallerKey(facts.jobId)
  const job = await loadJob(input.jobId)
  if (isFail(job)) return job
  const { CompanyMovingError, saveDocumentForAccount, saveDocumentForContact } = await import('@/lib/crm-store/save-for-account')
  try {
    const buf = Buffer.from(bytes)
    const row = { service_delivery_id: facts.jobId, flow_stage: job.job.stage, status: 'classified' }
    let saved
    if (job.job.account_id) {
      saved = await saveDocumentForAccount({
        accountId: job.job.account_id,
        name,
        bytes: buf,
        mimeType: 'application/pdf',
        folder: 'company',
        documentType: EIN_PACKAGE_DOC_TYPE,
        callerKey,
        portalVisible: false,
        row: { ...row, contact_id: job.job.contact_id },
      })
    } else if (job.job.contact_id) {
      const { ensurePersonOwner } = await import('@/lib/crm-store/formation-pilot')
      const { liveOwnerOfContact } = await import('@/lib/crm-store/switched-drive-guard')
      const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', job.job.contact_id).maybeSingle()
      const contactName = (c as { full_name?: string | null } | null)?.full_name ?? null
      if (!(await liveOwnerOfContact(job.job.contact_id))) await ensurePersonOwner(job.job.contact_id, contactName || 'Member')
      saved = await saveDocumentForContact({
        contactId: job.job.contact_id,
        name,
        bytes: buf,
        mimeType: 'application/pdf',
        documentType: EIN_PACKAGE_DOC_TYPE,
        callerKey,
        contactName,
        portalVisible: false,
        row,
      })
    } else {
      return { ok: false, error: 'This job has neither a company nor a person, so there is nowhere to save the letter.', status: 400 }
    }
    if (saved.route !== 'store') return { ok: false, error: "This company's files are not in the new storage yet, so the letter could not be saved.", status: 409 }
    return { ok: true, documentId: saved.documentRowId, name, pages, attachedNotice: notice?.name ?? null, signed: !!signaturePng, warnings }
  } catch (e) {
    if (e instanceof CompanyMovingError) return { ok: false, error: e.message, status: 409 }
    return { ok: false, error: `Could not save the letter: ${e instanceof Error ? e.message : String(e)}`, status: 500 }
  }
}
