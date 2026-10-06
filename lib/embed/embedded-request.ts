/**
 * "Is this page being loaded INSIDE A FRAME?" — the one decision window mode hangs on
 * (dev job f3f3e237, step 4).
 *
 * The browser labels a page that an <iframe> loads with `Sec-Fetch-Dest: iframe`. That label is a UI
 * HINT, never a security switch (the client controls it): the login check in the layout still runs
 * for every request, framed or not.
 *
 * It is also only true for the FIRST load of the frame. Later refreshes of the same frame
 * (router.refresh(), data revalidation) are fetch requests labelled `empty`, so a caller must read
 * this ONCE and freeze it — see components/dashboard/embedded-shell.tsx.
 *
 * It only survives if nothing in between re-requests the page: the dashboard service worker used
 * to answer navigations with fetch(event.request), which makes the browser drop the label
 * (found by browser QA 2026-10-05; public/dashboard-sw.js now lets framed loads bypass it).
 */

/** True only for a page load made by a frame. */
export function isFramedNavigation(secFetchDest: string | null | undefined): boolean {
  return typeof secFetchDest === 'string' && secFetchDest.trim().toLowerCase() === 'iframe'
}

/**
 * Window mode: a framed page load AND the admin switch (`floating_windows_enabled`) is on.
 * The switch is passed in already resolved, so this stays pure.
 */
export function isEmbeddedRequest(secFetchDest: string | null | undefined, windowsEnabled: boolean): boolean {
  return windowsEnabled === true && isFramedNavigation(secFetchDest)
}
