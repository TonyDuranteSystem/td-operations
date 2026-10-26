/**
 * The switch for "several agreements in one short contract, signed once" (flexible-offer slice 2).
 * Server-only (reads app_settings). OFF by default and fails CLOSED: a missing row or a failed read
 * means OFF, and OFF means the contract page is exactly what it always was.
 *
 * Staff previews (?preview=td with a real staff session) always see the new page so it can be
 * tested while clients still get the old one. Flip it in Dev Tools → Maintenance.
 */
import { getAppSetting } from '@/lib/settings'

export const MULTI_AGREEMENTS_KEY = 'short_contract_multi_agreements' as const

export async function multiAgreementsEnabled(opts: { staffPreview?: boolean } = {}): Promise<boolean> {
  if (opts.staffPreview) return true
  try {
    return (await getAppSetting<boolean>(MULTI_AGREEMENTS_KEY, false)) === true
  } catch {
    return false
  }
}
