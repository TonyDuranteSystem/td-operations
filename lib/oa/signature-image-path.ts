/**
 * Which stored object is member N's signature picture — or refuse.
 *
 * The signing route writes `<token>/sig-<memberIndex>.png` and records it in
 * `oa_signatures.signature_image_path`; older rows carry a suffix
 * (`sig-0-mrva2n4k.png`). The recorded value is still writable from the browser
 * side in places, so — exactly like `resolveSignedPdfPath` — it is confined to the
 * agreement's own folder, one segment, and to THIS member's picture, before the
 * server reads it with the service key. Pure, no I/O.
 *
 * FLAT result (the repo compiles with `strict: false`).
 */
export interface SignatureImagePathResult {
  ok: boolean
  path: string | null
}

export function resolveSignatureImagePath(
  token: string | null | undefined,
  memberIndex: number,
  recordedPath: string | null | undefined,
): SignatureImagePathResult {
  const path = (recordedPath ?? "").trim()
  const folder = (token ?? "").trim()
  if (!path || !folder || !Number.isInteger(memberIndex) || memberIndex < 0) return { ok: false, path: null }
  const prefix = `${folder}/`
  if (!path.startsWith(prefix)) return { ok: false, path: null }
  const rest = path.slice(prefix.length)
  if (!rest || rest.includes("/")) return { ok: false, path: null }
  // `sig-<index>.png` or `sig-<index>-<suffix>.png` — and only THIS member's.
  const own = new RegExp(`^sig-${memberIndex}(-[A-Za-z0-9_]+)?\\.png$`)
  if (!own.test(rest)) return { ok: false, path: null }
  return { ok: true, path }
}
