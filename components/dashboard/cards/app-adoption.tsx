import { Smartphone, BellRing } from 'lucide-react'
import { getPwaAdoptionStats } from '@/lib/portal/pwa-stats'

/**
 * Staff card: PWA install-adoption funnel (Phase 2, dev job 8f38add1).
 * The headline number is the one that matters — % of active client accounts
 * actually RECEIVING push (derived live from push_subscriptions, D6b) — not
 * raw installs, which deliver nothing without the notification permission.
 */
export async function AppAdoptionCard() {
  const stats = await getPwaAdoptionStats()
  const srcEntries = Object.entries(stats.funnel30d.pageViewsBySrc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  return (
    <div className="bg-white rounded-lg border p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
        Portal App Adoption
      </h3>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
          <BellRing className="h-5 w-5 text-red-600" />
        </div>
        <div>
          <p className="text-2xl font-semibold leading-none">
            {stats.pushCoveragePct}%
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            of active accounts receive push ({stats.accountsWithPush}/{stats.activeAccounts})
          </p>
        </div>
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Install-page visits (30d)</span>
          <span className="font-medium">{stats.funnel30d.pageViews}</span>
        </div>
        {srcEntries.map(([src, n]) => (
          <div key={src} className="flex justify-between pl-3">
            <span className="text-muted-foreground">{src}</span>
            <span>{n}</span>
          </div>
        ))}
        <div className="flex justify-between">
          <span className="text-muted-foreground">Installs — Android (30d)</span>
          <span className="font-medium">{stats.funnel30d.installsAndroid}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">First app launches (30d)</span>
          <span className="font-medium">{stats.funnel30d.standaloneLaunches}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">…of which logged in</span>
          <span className="font-medium">{stats.funnel30d.standaloneAuthenticated}</span>
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground mt-3 pt-3 border-t">
        <Smartphone className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        iPhone installs can&apos;t be tied to a specific QR/link (Apple provides no
        referrer) — they appear as app launches only. Android installs are
        counted per channel.
      </p>
    </div>
  )
}
