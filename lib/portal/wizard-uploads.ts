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
      if (prefixes.some(p => s.startsWith(p))) paths.push(s)
    }
  }
  return paths
}
