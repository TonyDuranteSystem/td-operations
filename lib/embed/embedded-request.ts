/**
 * "Is this page being loaded INSIDE a frame?" — the one decision the floating-window
 * spike (dev job f3f3e237, step 3) hangs on.
 *
 * The browser labels a page that an <iframe> loads with `Sec-Fetch-Dest: iframe`.
 * That label is a UI HINT, never a security switch (the client controls it): the
 * login check in the layout still runs for every request, framed or not.
 *
 * It is also only true for the FIRST load of the frame. Later refreshes of the same
 * frame (router.refresh(), data revalidation) are fetch requests labelled `empty`,
 * so a caller must read this ONCE and freeze it — see components/dashboard/embedded-shell.tsx.
 *
 * The spike flag (env WINDOW_SPIKE=1) is set ONLY on the private sandbox address. With
 * the flag absent this always returns false, so nothing changes anywhere else.
 */
export function isEmbeddedRequest(
  secFetchDest: string | null | undefined,
  spikeFlag: string | undefined,
): boolean {
  if (spikeFlag !== '1') return false
  return typeof secFetchDest === 'string' && secFetchDest.trim().toLowerCase() === 'iframe'
}
