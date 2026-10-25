/**
 * "Is this attachment URL ours?" for the portal chat send route (security hunt 2026-10-25).
 *
 * The old check was a bare `url.startsWith(supabaseBaseUrl)`, which `https://<ref>.supabase.co.attacker.tld/x` and
 * `https://<ref>.supabase.co@attacker.tld/x` both pass. Here the URL is parsed and the ORIGIN (scheme + host + port) must match
 * exactly, then the path must sit under the storage API (or be exactly the access-controlled attachment proxy).
 */

function originOf(base: string): string | null {
  try { return new URL(base.trim()).origin } catch { return null }
}

export function isOwnAttachmentUrl(rawUrl: unknown, supabaseBaseUrl: string, portalBaseUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return false
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.username || u.password) return false
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const supa = originOf(supabaseBaseUrl)
  if (supa && u.origin === supa && u.pathname.startsWith('/storage/v1/object/') && !u.pathname.includes('..')) return true
  const portal = originOf(portalBaseUrl)
  if (portal && u.origin === portal && u.pathname === '/api/portal/chat/attachment') {
    const p = u.searchParams.get('path') ?? ''
    return p.startsWith('chat-attachments/') && !p.includes('..')
  }
  return false
}
