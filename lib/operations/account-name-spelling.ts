/**
 * "Fix spelling" (Antonio, 2026-10-19): used when WE wrote a company's name wrongly in the CRM. The person types the RIGHT name and
 * that is all — there is no limit on how different it is. It renames the company in place and renames its storage top folder to match
 * (that is the point of the tool: the storage follows). It records NO previous name and archives NO folder: a wrong entry is not a name
 * the company ever had. A company that really changed its name goes through the Change Name workspace, whose name is right by construction.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

/** PURE: the plain reason this name cannot be saved, or null. (Anything else the person typed is taken as the right name.) */
export function spellingFixProblem(current: string, next: string): string | null {
  const cleaned = (next ?? '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'Type the correct name.'
  if (cleaned.length > 200) return 'That name is too long.'
  if (cleaned === (current ?? '').trim()) return 'That is already the name.'
  return null
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
