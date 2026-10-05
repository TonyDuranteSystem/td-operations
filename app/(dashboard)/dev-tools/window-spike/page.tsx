import WindowSpike from './window-spike'

/**
 * Floating-window frame TEST page (dev job f3f3e237, step 3). Throwaway.
 *
 * Under /dev-tools, so the existing admin-only rule in middleware already keeps everyone
 * else out. Window mode itself only switches on when the server flag WINDOW_SPIKE=1 is
 * set (private sandbox address only); this page says which state it is in.
 */
export const dynamic = 'force-dynamic'

export default function WindowSpikePage() {
  const flagOn = process.env.WINDOW_SPIKE === '1'
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <WindowSpike flagOn={flagOn} />
    </div>
  )
}
