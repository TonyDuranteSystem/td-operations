/**
 * Client iPhone app — the "which company" part of an address (pure; dev job 056a70d0, Step 3).
 *
 * The portal pages know the selected company from the website's cookies, but the app's server doors (`/api/portal/app/…`) never see
 * those cookies (they are written for `/portal` only; see `selectionReader` in gate.ts). A portal page in the app therefore builds the
 * address part itself from what the layout already resolved: `account=<id>`, `formation=<id>` or `onboarding=<id>`, plus `mode=partner`
 * only for the partner view (the default `client` is not written). Returns "" when nothing is selected, so the door answers for the first company.
 */
export function selectionQuery(sel: {
  kind: 'account' | 'formation' | 'onboarding' | 'none'
  id?: string
  mode?: 'client' | 'partner' | null
}): string {
  const p = new URLSearchParams()
  if (sel.kind !== 'none' && sel.id) p.set(sel.kind, sel.id)
  if (sel.mode === 'partner') p.set('mode', 'partner')
  return p.toString()
}
