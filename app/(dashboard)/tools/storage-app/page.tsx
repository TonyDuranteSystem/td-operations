/**
 * /tools/storage-app — "TD Storage install": download and install the TD Storage Mac app (the CRM storage as a Finder location).
 * Visible only to admins and the staff on the Mac-app allow-list (Antonio, 2026-10-22). The app updates itself after the first install.
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin, isOwnerOnly } from "@/lib/auth"
import { canSeeInstallPage } from "@/lib/storage-app/install-access"
import { loadRelease } from "@/lib/storage-app/release"
import { ReleasePanel } from "./release-panel"

export const dynamic = "force-dynamic"

const STEPS = [
  "Download the app with the button above (a zip file) and open it — macOS unzips it to “TD Storage”.",
  "Drag “TD Storage” into your Applications folder, then open it from there.",
  "Press “Sign in…”. A page opens in your browser: check that the code on that page is the same as in the app, then approve this Mac with your CRM login.",
  "Wait about half a minute: “TD Storage” appears in the Finder sidebar, showing the same folders as the CRM Storage page.",
]

export default async function StorageAppInstallPage() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !(await canSeeInstallPage(user))) redirect("/")
  const release = await loadRelease()
  const admin = isAdmin(user)
  const owner = isOwnerOnly(user)
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">TD Storage install</h1>
        <p className="mt-1 text-sm text-muted-foreground">The CRM storage as a folder in Finder on your Mac — open files, and save new ones into it.</p>
      </div>

      <div className="rounded-lg border bg-white p-5">
        {release ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-800">Version {release.version}</div>
                {release.publishedAt && <div className="text-xs text-muted-foreground">Published {new Date(release.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>}
              </div>
              {/* a plain link: the route answers with a redirect to a 60-second download link */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/api/store-devices/app-download" className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Download for Mac</a>
            </div>
            {release.notes && <p className="mt-3 whitespace-pre-line text-sm text-zinc-600">{release.notes}</p>}
            <p className="mt-3 text-xs text-muted-foreground">Needs macOS {release.minSystem} or newer. Install it once on each Mac — after that it updates itself, nobody has to do anything.</p>
            {admin && !release.enabled && <p className="mt-2 text-xs font-medium text-amber-700">Updates are paused (this version is not being offered to installed Macs).</p>}
            {admin && release.enabled && release.rolloutPercent < 100 && <p className="mt-2 text-xs font-medium text-amber-700">Gradual roll-out: installed Macs are offered this version at {release.rolloutPercent}%.</p>}
          </>
        ) : (
          <p className="text-sm text-zinc-600">No version of the app is published yet.</p>
        )}
      </div>

      {owner && <ReleasePanel current={release ? { version: release.version, build: release.build, enabled: release.enabled, rolloutPercent: release.rolloutPercent } : null} />}

      <div className="rounded-lg border bg-white p-5">
        <h2 className="text-sm font-semibold text-zinc-800">How to install</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-700">
          {STEPS.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">
          A Mac that has not reached the CRM for 24 hours signs itself out and clears its TD Storage folder — just sign in again.
          Lost or changed Mac? Sign it out from <Link href="/storage-app/devices" className="underline">My devices</Link>.
        </p>
      </div>
    </div>
  )
}
