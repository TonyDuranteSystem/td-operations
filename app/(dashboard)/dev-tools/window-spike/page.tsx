import WindowSpike from './window-spike'
import { isFloatingWindowsEnabled } from '@/lib/settings'

/**
 * Floating-window frame TEST page (dev job f3f3e237, step 3). Throwaway.
 *
 * Under /dev-tools, so the existing admin-only rule in middleware already keeps everyone
 * else out. Window mode itself only switches on when the admin switch
 * `floating_windows_enabled` is on (Dev Tools → Maintenance; off by default); this page says
 * which state it is in.
 */
export const dynamic = 'force-dynamic'

export default async function WindowSpikePage() {
  const flagOn = await isFloatingWindowsEnabled()
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <WindowSpike flagOn={flagOn} />
    </div>
  )
}
