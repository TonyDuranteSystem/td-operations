/**
 * TD Talk — keeping a hidden Chrome tab awake so the voice still speaks (pure; Antonio, 30 Oct 2026: "yes step 3").
 * Chrome slows (and can freeze) a tab you are not looking at, but not a tab that is playing sound. So while Voice is On the page plays a tone far too low and too quiet to hear
 * (about 40 Hz at roughly -54 dBFS) — still above Chrome's "silence" threshold, so the tab counts as playing audio and keeps its live connection and timers. The price: Chrome shows
 * a small speaker icon on the tab, and a little more battery. Not verified on Antonio's Chrome yet. The audio parts live in `components/talk/talk-keep-alive.tsx`.
 */

export const KEEP_ALIVE_HZ = 40
/** Peak amplitude of the tone: 0.002 is about -54 dBFS. */
export const KEEP_ALIVE_GAIN = 0.002

/** The keep-alive tone runs only while Voice is On and the page has been touched (a browser lets a page make sound only after a click). */
export function keepAliveWanted(voiceOn: boolean, touched: boolean): boolean {
  return voiceOn && touched
}
