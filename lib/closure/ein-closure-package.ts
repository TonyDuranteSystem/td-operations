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
import { buildEinClosureLetter, einClosureLetterProblems } from '@/lib/closure/ein-closure-letter'
import { parseStorePointer } from '@/lib/crm-store/document-pointer'
import { looksLikePng, MAX_SIGNATURE_BYTES, signaturePathsOf, einDigits, signatureFingerprint, sameSignedCompany, normalizeCompanyName } from '@/lib/closure/signature-consent'
import { createHash } from 'crypto'
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

/** How a file was recognised as an EIN notice: by its document TYPE (staff or the system typed it) or only by its file name (a guess). */
export type NoticeMatch = 'type' | 'name' | null

export interface EinClosureFacts {
  jobId: string
  stage: string | null
  /** 'active' / 'cancelled' / 'completed' — a letter is only made for an open closure */
  jobStatus: string | null
  /** a short fingerprint of what the box shows (company, EIN, signer, signature, EIN copies): the letter is made only if it is still the same when staff press the button */
  factsHash: string
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

/**
 * How this stored file is recognised as the company's EIN notice (CP 575 / 147C / "EIN letter") — and never our own closure letter or the IRS's
 * closure answer. A typed file ("EIN Letter (IRS)", "EIN CP575B"…) is a sure match; a file known only by its NAME is a guess, so it is offered but
 * never preselected on its own. The words are matched as whole words ("disclosure", "enclosure" are not "closure").
 */
export function einNoticeMatch(fileName: string, typeLabel: string | null): NoticeMatch {
  const name = fileName.trim()
  if (/^EIN Closure Letter/i.test(name)) return null // our own package
  const type = (typeLabel ?? '').trim()
  if (/cancel/i.test(type)) return null // a cancellation request, not the notice
  if (/^EIN\b/i.test(type)) return 'type' // "EIN IRS FAX - LTR 147C", "EIN Letter (IRS)", "EIN CP575B"…
  // the file the closure wizard minted for its own "EIN letter" field (ein_letter_<8 hex>_<the client's file name>): whatever the client called their file ("EIN letter for closure.pdf"), it IS the one they uploaded for this closure
  if (/^ein_letter_[0-9a-f]{8}_/i.test(name)) return 'name'
  if (/(?<![a-z])(closure|cancel[a-z]*)/i.test(name)) return null // a closure / cancellation file named by the client or the IRS
  if (/^ein[_ -]?letter/i.test(name) || /(?<![a-z0-9])(cp[ _-]?575[a-z]?|147c)(?![a-z0-9])/i.test(name)) return 'name' // the wizard's field name prefix, or the IRS form number
  return null
}

export const isEinNoticeCandidate = (fileName: string, typeLabel: string | null): boolean => einNoticeMatch(fileName, typeLabel) !== null

/** Staff type an address in a box: one line per row. Nothing is cut here — a letter that cannot hold it says so (einClosureLetterProblems) instead of losing the end of the address. */
export function splitAddress(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/**
 * The company's address on file as the lines of the letter. A multi-line address is kept as it is; a one-line "street, suite, City, ST 12345" becomes
 * the street part and a "City, ST 12345" line — nothing is dropped (it used to keep only the first four comma pieces).
 */
export function addressToLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const one = lines[0] ?? ''
  const parts = one.split(/,\s*/).map((p) => p.trim()).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  if (parts.length >= 3 && /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(last)) {
    return [parts.slice(0, -2).join(', '), `${parts[parts.length - 2]}, ${last}`]
  }
  return parts.length > 0 ? parts : []
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

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadJob(jobId: string): Promise<{ ok: true; job: JobRow } | { ok: false; error: string; status: number }> {
  // not an id at all: the same plain answer as a job that does not exist (never a database error sentence)
  if (!UUID_SHAPE.test(jobId)) return { ok: false, error: 'Job not found.', status: 404 }
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

/** Which of these stored files are still LIVE in the storage (a trashed or purged file must not be offered, attached or embedded). */
async function liveStoreIds(ids: string[]): Promise<{ ok: true; live: Set<string> } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, live: new Set() }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until they reach production
  const { data, error } = await (supabaseAdmin as any).from('store_files').select('id, state').in('id', ids)
  if (error) return { ok: false, error: `Could not check the stored files: ${error.message}` }
  return { ok: true, live: new Set(((data ?? []) as Array<{ id: string; state: string | null }>).filter((r) => r.state === 'live').map((r) => r.id)) }
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
  if (!answers && (job.account_id || job.contact_id)) {
    warnings.push("The system could not tell which closure wizard answers belong to this job (another closure of the same company or person is open, or the form is not sent yet), so the client's signature and wizard answers are NOT used — fill in the address below and the letter has a line to sign by hand.")
  }

  // the company: our record when the job has one, else what the client wrote
  const wizardName = str('llc_name')
  const wizardEin = str('llc_ein')
  let companyName = wizardName
  let ein = wizardEin
  let state: string | null = str('llc_state') || null
  let addressLines: string[] = []
  let addressSource: EinClosureFacts['addressSource'] = 'none'
  let clientWroteOtherCompany = false
  if (job.account_id) {
    const { data: acc, error } = await supabaseAdmin.from('accounts').select('company_name, ein_number, state_of_formation, physical_address').eq('id', job.account_id).maybeSingle()
    if (error) return { ok: false, error: `Could not read the company: ${error.message}`, status: 500 }
    if (acc) {
      // `||` not `??`: an empty text in our record must not hide what the client wrote
      companyName = ((acc.company_name as string | null) ?? '').trim() || companyName
      ein = ((acc.ein_number as string | null) ?? '').trim() || ein
      state = ((acc.state_of_formation as string | null) ?? '').trim() || state
      if (wizardName && companyName && normalizeCompanyName(wizardName) !== normalizeCompanyName(companyName)) {
        clientWroteOtherCompany = true
        warnings.push(`The client wrote "${wizardName}" in the wizard, but this job is for "${companyName}". The letter uses ${companyName}.`)
      }
      if (einDigits(wizardEin) && einDigits(ein) && einDigits(wizardEin) !== einDigits(ein)) {
        clientWroteOtherCompany = true
        warnings.push(`The client's form says the EIN is ${wizardEin}, but our record says ${ein}. The letter uses our record (${ein}) — check the EIN letter before it goes.`)
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
        addressLines = addressToLines(acc.physical_address)
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

  // the client's drawn signature: the file the wizard filed under the field `signature_image` — THE file the answers name, not just any file with
  // that prefix — AND the consent record the SERVER wrote for it (a file with no consent record, staff uploaded or a forged answer, is never used)
  const sigPaths = signaturePathsOf(answers?.signature_image)
  const sigFileName = sigPaths.length > 0 ? (sigPaths[sigPaths.length - 1].split('/').pop() ?? null) : null
  const sigDoc = sigFileName ? docs.find((d) => d.file_name === sigFileName) : undefined
  const anyOtherSigDoc = !sigDoc && docs.some((d) => /^signature_image/i.test(d.file_name))
  const signedAt = str('signature_signed_at') || null
  const hasConsent = !!signedAt && !!str('signature_consent')

  const noticeDocs = docs.filter((d) => einNoticeMatch(d.file_name, d.document_type_name) !== null).slice(0, 12)
  const storePointer = (d: Doc | undefined) => (d ? parseStorePointer(d.drive_file_id) : null)
  const liveCheck = await liveStoreIds([...noticeDocs.map((d) => storePointer(d)), storePointer(sigDoc)].filter((x): x is string => !!x))
  if (isFail(liveCheck)) return { ok: false, error: liveCheck.error, status: 500 }
  const liveOnly = (id: string | null) => (id && liveCheck.live.has(id) ? id : null)

  const notices: EinNoticeCandidate[] = noticeDocs.map((d) => ({
    documentId: d.id,
    name: d.file_name,
    typeLabel: d.document_type_name,
    storeFileId: liveOnly(storePointer(d)),
    mergeable: MERGEABLE_EXT.test(d.file_name),
    recommended: false,
  }))
  // preselect only what is certain: the file the wizard named for this closure, or the one typed EIN notice — never a name-only guess, and
  // nothing at all when the client wrote another company than the one this job is for (the copy could be the other company's)
  if (!clientWroteOtherCompany) {
    const wizardOne = notices.find((n) => /^ein[_ -]?letter/i.test(n.name))
    if (wizardOne) wizardOne.recommended = true
    else if (notices.length === 1 && einNoticeMatch(noticeDocs[0].file_name, noticeDocs[0].document_type_name) === 'type') notices[0].recommended = true
  } else if (notices.length > 0) {
    warnings.push("No EIN copy is preselected because of the difference above — check that the one you attach is this company's.")
  }

  const sigFileId = liveOnly(storePointer(sigDoc))
  // the signature belongs to the letter the client SAW (company, EIN, owner as typed in the wizard): if this letter is for another company or EIN
  // (our record differs from what the client wrote), the signature is NOT used
  const factsFingerprint = `${normalizeCompanyName(companyName)}|${einDigits(ein)}|`
  const signedFingerprint = (str('signature_for') || (answers ? signatureFingerprint(answers) : '')).split('|').slice(0, 2).join('|') + '|'
  const signedForThisLetter = !answers || sameSignedCompany(signedFingerprint, factsFingerprint)
  if (hasConsent && !signedForThisLetter) {
    warnings.push(`The client signed a letter for "${wizardName || '?'}" (EIN ${wizardEin || '?'}), but this letter is for "${companyName}" (EIN ${ein || '?'}). The signature is NOT used — the letter has a line to sign by hand.`)
  }
  if (sigDoc && !hasConsent) warnings.push("A signature picture is on this job but the client's consent was not recorded, so it is NOT used — the letter has a line to sign by hand.")
  if (sigFileName && hasConsent && !sigDoc) {
    warnings.push(`The client drew a signature, but its picture is not on this job${anyOtherSigDoc ? ' (only another signature file is)' : ' yet (it may still be filing — look again in a minute)'}. The letter has a line to sign by hand until then.`)
  }
  if (sigDoc && hasConsent && !sigFileId) warnings.push("The client's signature picture is not in the new storage (or was removed), so it cannot be used — the letter has a line to sign by hand.")
  const usableSignature = !!sigFileId && hasConsent && signedForThisLetter

  const existing = docs.find((d) => /^EIN Closure Letter/i.test(d.file_name))
  if (notices.length === 0) warnings.push('No copy of the EIN letter is on this job. The IRS asks for one if the client still has it — the letter can go without it.')
  if (notices.some((n) => !n.mergeable)) warnings.push('One of the EIN letter files is not a PDF or a picture the system can join (for example a phone HEIC photo) — it cannot be attached.')
  if (notices.some((n) => n.mergeable && !n.storeFileId)) warnings.push('One of the EIN letter files is not in the new storage (or was removed), so it cannot be attached.')
  const returnsFiled = str('tax_returns_filed') || null
  if (returnsFiled && returnsFiled.toLowerCase() !== 'yes') {
    warnings.push(
      returnsFiled.toLowerCase() === 'no'
        ? 'The client says tax returns were NOT all filed. The IRS will not close the account until every return is filed and taxes are paid — a final return may be needed before this letter goes.'
        : 'The client is not sure whether all tax returns were filed. The IRS will not close the account until every return is filed and taxes are paid — check before this letter goes.',
    )
  }

  const factsHash = createHash('sha256')
    .update(JSON.stringify({ c: companyName, e: ein, s: signerName, g: usableSignature ? sigFileId : null, n: notices.map((n) => `${n.documentId}:${n.storeFileId ?? ''}`).sort(), st: job.status }))
    .digest('hex')
    .slice(0, 16)

  return {
    ok: true,
    facts: {
      jobId: job.id,
      stage: job.stage,
      jobStatus: job.status,
      factsHash,
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
  /** the fingerprint of the box staff were looking at (facts.factsHash); when it differs now, nothing is made and staff are asked to look again */
  factsHash?: string | null
  now?: Date
}

export type BuildPackageResult =
  | { ok: true; documentId: string; name: string; pages: number; attachedNotice: string | null; signed: boolean; warnings: string[] }
  | { ok: false; error: string; status: number }

export async function buildEinClosurePackage(input: BuildPackageInput): Promise<BuildPackageResult> {
  const f = await loadEinClosureFacts(input.jobId)
  if (isFail(f)) return f
  const facts = f.facts

  // a letter is only made for an OPEN closure (a cancelled or finished job keeps no new paperwork)
  if (facts.jobStatus && facts.jobStatus !== 'active') return { ok: false, error: `This closure is ${facts.jobStatus} — the letter is only made for an open closure.`, status: 409 }
  if (input.factsHash && input.factsHash !== facts.factsHash) {
    return { ok: false, error: 'Something changed since you opened this box (the client, the company record or the files were updated). The box has been reloaded — check it, then press the button again.', status: 409 }
  }

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
  let signed = false
  try {
    const made = await buildEinClosureLetter({
      companyName: facts.companyName,
      ein: facts.ein,
      companyAddressLines: input.addressLines,
      signerName: facts.signerName,
      date: input.now ?? new Date(),
      includesEinNotice: !!notice,
      signaturePng,
    })
    letter = made.bytes
    signed = made.signatureUsed
    warnings.push(...made.warnings)
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
    if (saved.route !== 'store') {
      // say the REAL reason (closed / moving / no folder) when the storage rules know it
      let why = "This company's files are not in the new storage yet, so the letter could not be saved."
      try {
        const { noStorageDecisionFor, noStorageDecisionForContact } = await import('@/lib/crm-store/no-storage')
        const d = job.job.account_id ? await noStorageDecisionFor(job.job.account_id) : await noStorageDecisionForContact(job.job.contact_id as string)
        if (d.route === 'refuse') why = `${d.sentence} The letter could not be saved.`
      } catch {
        /* keep the general sentence */
      }
      return { ok: false, error: why, status: 409 }
    }
    return { ok: true, documentId: saved.documentRowId, name, pages, attachedNotice: notice?.name ?? null, signed, warnings: Array.from(new Set(warnings)) }
  } catch (e) {
    if (e instanceof CompanyMovingError) return { ok: false, error: e.message, status: 409 }
    return { ok: false, error: `Could not save the letter: ${e instanceof Error ? e.message : String(e)}`, status: 500 }
  }
}
