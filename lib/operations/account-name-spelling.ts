/**
 * "Fix spelling" (Antonio, 2026-10-19): a company's legal name changes ONLY through the Change Name service — except for a typo.
 * This is the small, separate path for a typo: it accepts only a correction of at most TWO letters (ONE for a short name; or capital letters / spacing),
 * renames the company in place and renames its storage top folder to match. It records NO previous name and archives NO folder:
 * a typo is not a name the company ever had. A real new name is refused with a pointer to Change Name.
 *
 * The check is a safeguard, not a judgement: the person pressing the button says "this is a typo"; two letters is the most a typo
 * of this kind is allowed to be (one for a name under ten letters), and extremely short names are refused outright.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { nameKey } from '@/lib/operations/account-name-change'

export const MAX_SPELLING_DISTANCE = 2
const MIN_BASE_LENGTH = 5

export const NOT_A_SPELLING_FIX =
  "That is a new name, not a spelling fix (more than two letters are different). Use the Change Name service on the company's page."

/** Levenshtein distance (single-letter insert / delete / replace). Pure. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

const SUFFIX = /\s*(limited liability company|llc)$/

/** The name without its ending "LLC" / "Limited Liability Company" — what the letters are counted on. */
function baseOf(key: string): string {
  return key.replace(/[.,]/g, '').replace(SUFFIX, '').trim()
}

/** Short names tolerate only ONE letter: with fewer letters, a second one is more likely a different name than a typo. */
function allowedDistance(base: string): number {
  return base.length < 10 ? 1 : MAX_SPELLING_DISTANCE
}

/** PURE: the plain reason this edit is not a spelling fix, or null when it is one. */
export function spellingFixProblem(current: string, next: string): string | null {
  const cleaned = (next ?? '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'Type the corrected name.'
  if (cleaned.length > 200) return 'That name is too long.'
  if (cleaned === (current ?? '').trim()) return 'That is already the name.'
  const a = nameKey(current ?? '')
  const b = nameKey(cleaned)
  if (a === b) return null // capital letters / spacing only
  const baseA = baseOf(a)
  const baseB = baseOf(b)
  if (baseA.length < MIN_BASE_LENGTH || baseB.length < MIN_BASE_LENGTH) {
    return "This name is too short to tell a typo from a different name. Use the Change Name service on the company's page."
  }
  // letters are counted on the name without its LLC ending; adding or dropping the ending itself counts as one letter
  const distance = editDistance(baseA, baseB) + (SUFFIX.test(a) !== SUFFIX.test(b) ? 1 : 0)
  return distance <= Math.min(allowedDistance(baseA), allowedDistance(baseB)) ? null : NOT_A_SPELLING_FIX
}

export interface SpellingFixResult {
  ok: boolean
  error?: string
  oldName?: string
  newName?: string
  /** the storage top folder was renamed too (false = the company has no storage / it already had that name) */
  folderRenamed?: boolean
}

export async function fixCompanyNameSpelling(p: { accountId: string; newName: string; actor: string }): Promise<SpellingFixResult> {
  const { data: acct, error: readErr } = await supabaseAdmin.from('accounts').select('company_name, notes').eq('id', p.accountId).maybeSingle()
  if (readErr || !acct?.company_name) return { ok: false, error: 'Company not found.' }
  const oldName = acct.company_name as string
  const newName = (p.newName ?? '').replace(/\s+/g, ' ').trim()
  const problem = spellingFixProblem(oldName, newName)
  if (problem) return { ok: false, error: problem }

  // The storage top folder follows the corrected name (in place; a typo never archives anything).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store_* functions are not in the generated types
  const db = supabaseAdmin as any
  let ownerId: string | null = null
  let folderRenamed = false
  const { data: owner } = await db.from('store_owners').select('id').eq('account_id', p.accountId).maybeSingle()
  ownerId = (owner?.id as string | undefined) ?? null
  const { storeSafeFolderName } = await import('@/lib/crm-store/formation-pilot')
  if (ownerId) {
    const { data: renamed, error } = await db.rpc('store_rename_root', { p_owner_id: ownerId, p_name: storeSafeFolderName(newName), p_actor: null })
    if (error) return { ok: false, error: 'The storage folder could not be renamed, so nothing was changed. Please try again.' }
    folderRenamed = renamed === true
  }

  // compare-and-set on the old name: if someone changed it meanwhile, put the folder back and refuse
  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned typo-fix write of company_name (the generic edit paths refuse real renames)
  const { data: updated, error: upErr } = await supabaseAdmin.from('accounts').update({ company_name: newName }).eq('id', p.accountId).eq('company_name', oldName).select('id')
  if (upErr || !updated || updated.length === 0) {
    if (ownerId && folderRenamed) await db.rpc('store_rename_root', { p_owner_id: ownerId, p_name: storeSafeFolderName(oldName), p_actor: null })
    return { ok: false, error: 'The company name changed while you were editing. Reload the page and try again.' }
  }

  // CRM update rule: a dated line in the company's notes. Best-effort — the correction itself is done.
  try {
    const day = new Date().toISOString().slice(0, 10)
    const line = `${day}: Company name spelling corrected from "${oldName}" to "${newName}" (${p.actor}).`
    // eslint-disable-next-line no-restricted-syntax -- a dated CRM note line (CRM update rule)
    await supabaseAdmin.from('accounts').update({ notes: [acct.notes, line].filter(Boolean).join('\n') }).eq('id', p.accountId)
  } catch (err) {
    console.error('fixCompanyNameSpelling: could not write the CRM note:', err)
  }
  return { ok: true, oldName, newName, folderRenamed }
}
