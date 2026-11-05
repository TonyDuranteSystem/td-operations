/**
 * The service list of Create Offer (offer builder, dev job d2971d11): what GET /api/service-catalog answered, as a list.
 *
 * Only a reply that REALLY is a list counts. A background call that hits an expired login gets 401 + `{ error, code }` and a
 * failed read of the list gets 500 + `{ error }` — both are perfectly readable JSON with no `services`, and reading them as
 * "an empty list" showed the section headings with no services and no message. Here they are null, so the window keeps the
 * list it already has (and only says "failed to load" when it has none). Pure: no fetch, no React.
 */
export function parseServiceListReply(ok: boolean, body: unknown): Array<Record<string, unknown>> | null {
  if (!ok || !body || typeof body !== 'object') return null
  const services = (body as { services?: unknown }).services
  if (!Array.isArray(services)) return null
  return services.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
}
