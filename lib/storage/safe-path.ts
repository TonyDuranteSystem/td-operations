/**
 * Storage paths that arrive from client-submitted data (a wizard submission's `upload_paths`) — what may be trusted before the server
 * reads or signs them (dev job 64d2be64, bug-hunt 2026-11-04).
 *
 * The storage client builds a read URL as `<storage>/object/<bucket>/<path>` WITHOUT encoding the path, and `fetch` then collapses
 * `.` / `..` segments — so a crafted path like `onboarding/<id>/../../../x` reaches outside the bucket with the server's own key.
 * Signing (a batch call whose paths travel in the request body) is a literal lookup and is not affected; a direct read is.
 */

function hasControlCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * True when the path has nothing that can walk out of its folder: no `.` / `..` segment, no empty segment (`//`, leading or trailing
 * `/`), no backslash and no control character. Every real upload passes (the wizard names files `type/identifier/field_unique_name`).
 */
export function isTraversalSafePath(path: unknown): path is string {
  if (typeof path !== "string" || !path) return false
  if (path.includes("\\") || hasControlCharacter(path)) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

/**
 * True when the path can also be READ directly: on top of being traversal-safe it has no `?`, `#` or `%`, which the unencoded read URL
 * would cut off or decode. Such a file can still be shown to staff through its signed link — it just cannot be read by the server.
 */
export function isDirectReadSafePath(path: string): boolean {
  return isTraversalSafePath(path) && !/[?#%]/.test(path)
}
