/**
 * Wizard upload-path helpers.
 *
 * Portal wizard file fields used to store a SINGLE storage-path string per
 * field. They now store an ARRAY of paths (multi-file support, dev_task
 * 64bfcdd9). These helpers normalize either shape so every consumer — the
 * submit route's path extraction, the formation handler's passport copy, etc.
 * — works whether the value is a legacy string or a new array.
 *
 * All wizard uploads follow the path pattern:
 *   {wizardType}/{identifier}/{fieldName}_{unique}_{filename}
 * stored in the "onboarding-uploads" bucket. Detecting a storage path by its
 * wizard-type prefix (instead of a brittle field-name whitelist) keeps this
 * robust as new wizard types are added.
 */

import { isTraversalSafePath } from '@/lib/storage/safe-path'

/** Maximum size for any wizard-uploaded file. Matches the onboarding-uploads
 *  bucket's own Supabase-enforced limit and the ceiling already used
 *  elsewhere in this codebase for direct-to-storage uploads (assets,
 *  td-comm-deliverables) — not an arbitrary number. A client who selects a
 *  file over this size gets a clear message instead of a silent stuck upload
 *  (dev_task: Turcanu/Tacoli passport investigation). */
export const WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024

/** User-facing message for a file that exceeds WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES. */
export function wizardUploadTooLargeMessage(fileSizeBytes: number): string {
  const mb = (fileSizeBytes / (1024 * 1024)).toFixed(1)
  return `This file is too large (${mb} MB). Please upload a file under 100 MB.`
}

export const WIZARD_UPLOAD_PREFIXES = [
  'formation/',
  'onboarding/',
  'tax/',
  'tax_return/',
  'banking/',
  'banking_payset/',
  'banking_relay/',
  'itin/',
  'closure/',
  'company_info/',
  'wizard/',
] as const

/** True when a storage path is a wizard-form upload (matches a wizard prefix).
 *  A path that is NOT wizard-prefixed came from another source — e.g. the legacy
 *  external tax form's own bucket scheme — which the wizard's file fields cannot
 *  represent, so the client can neither see nor remove it in the wizard UI. */
export function isWizardUploadPath(
  p: string,
  prefixes: readonly string[] = WIZARD_UPLOAD_PREFIXES,
): boolean {
  return prefixes.some(pre => p.startsWith(pre))
}

/** Coerce a wizard field value (string | string[] | anything) to an array of
 *  string paths. Non-strings and non-string array members are dropped. */
export function normalizeUploadValue(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string')
  if (typeof val === 'string') return [val]
  return []
}

/** First storage path for a file field, or undefined. Used by consumers that
 *  only act on one file (e.g. owner-passport OCR). */
export function firstUploadPath(val: unknown): string | undefined {
  return normalizeUploadValue(val)[0]
}

/** Walk a wizard submission's values and collect every storage path that looks
 *  like a wizard upload. Handles both legacy single-string fields and new
 *  multi-file array fields. Feeds `upload_paths`, which all downstream Drive /
 *  passport / bank-statement processing relies on. */
export function collectUploadPaths(
  data: Record<string, unknown>,
  prefixes: readonly string[] = WIZARD_UPLOAD_PREFIXES,
): string[] {
  const paths: string[] = []
  for (const val of Object.values(data)) {
    for (const s of normalizeUploadValue(val)) {
      // a crafted path that walks out of its folder ("../") is not an upload (bug-hunt, job 64d2be64): every later read trusts this list
      if (isTraversalSafePath(s) && prefixes.some(p => s.startsWith(p))) paths.push(s)
    }
  }
  return paths
}

/**
 * Removes from the answers every wizard-upload path that sits in SOMEONE ELSE's folder (`<wizard>/<folder>/<file>`), in any field — a text answer
 * included. The files of a submission are copied into the sender's own storage from `upload_paths`, which is collected from every value of the
 * answers; a client who typed another client's file path into any box could otherwise have that file copied to themselves (production QA
 * 2026-11-10, hunter finding #12). The path itself is not guessable, but the server must not rely on that. Mutates `data`; returns what was removed.
 * A value that is not a wizard path is never touched. Pure — no I/O.
 */
export function dropForeignUploadPaths(
  data: Record<string, unknown>,
  ownFolders: readonly string[],
  prefixes: readonly string[] = WIZARD_UPLOAD_PREFIXES,
): string[] {
  const dropped: string[] = []
  const foreign = (v: unknown): boolean => {
    // a wizard path never contains a space (the path minter replaces every character outside letters, digits and . _ - @): a sentence that merely starts with "tax/" is an answer, not a file
    if (typeof v !== 'string' || /\s/.test(v) || !prefixes.some((p) => v.startsWith(p))) return false
    if (!isTraversalSafePath(v)) return true // a path that walks out of its folder is never one of the sender's
    const folder = v.split('/')[1] ?? ''
    return !ownFolders.includes(folder)
  }
  for (const key of Object.keys(data)) {
    const val = data[key]
    if (Array.isArray(val)) {
      const kept = val.filter((v) => !foreign(v))
      if (kept.length !== val.length) {
        for (const v of val) if (foreign(v)) dropped.push(v as string)
        data[key] = kept
      }
    } else if (foreign(val)) {
      dropped.push(val as string)
      data[key] = ''
    }
  }
  return dropped
}

