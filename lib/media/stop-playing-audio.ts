/**
 * Pause every voice note / audio player that is playing on the page (except `keep`).
 * Used before the microphone opens (on an iPhone the microphone comes back empty while sound is playing — WhatsApp stops the
 * playing note first) and when one voice note starts (so two never talk over each other).
 */
export function stopPlayingAudio(keep?: unknown, root: { querySelectorAll: (s: string) => ArrayLike<{ paused: boolean; pause: () => void }> } | null = typeof document === 'undefined' ? null : document): number {
  if (!root) return 0
  let stopped = 0
  const players = root.querySelectorAll('audio')
  for (let i = 0; i < players.length; i++) {
    const a = players[i]
    if (a === keep || a.paused) continue
    try { a.pause(); stopped++ } catch { /* ignore */ }
  }
  return stopped
}
