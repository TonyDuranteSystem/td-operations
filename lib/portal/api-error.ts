/**
 * R099: a client-side fetch to our own API must show the server's real reason, not a generic "Failed".
 * `throwIfNotOk` reads `{ error }` from a non-2xx response; `errorMessage` turns whatever was thrown into text.
 */
export async function throwIfNotOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return
  const d = await res.json().catch(() => ({} as { error?: string }))
  throw new Error((d && typeof d.error === 'string' && d.error) || fallback)
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}
