/**
 * The sandbox marker — and the BUILD STAMP.
 *
 * WHY the stamp (Antonio, 2026-08-12): he lost an hour QA-ing a pinned
 * deployment URL that was six hours behind the code, with no way to tell from
 * the screen. "I must be able to see, in one glance, which build I'm testing."
 *
 * Values are inlined at BUILD time (NEXT_PUBLIC_* is baked into the bundle by
 * Next.js), injected by scripts/deploy-sandbox.sh from the local git checkout.
 * They cannot come from Vercel's own git variables: this project is
 * deliberately git-DISCONNECTED (2026-08-07, to stop main builds stealing the
 * sandbox alias), so VERCEL_GIT_COMMIT_SHA is empty on every sandbox deploy.
 *
 * The time string is pre-formatted at deploy time — never computed here — so a
 * server-rendered banner can't drift from the client and trigger a hydration
 * mismatch.
 */

import { buildStampLabel } from "@/lib/build-stamp"

const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || ""
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || ""

export function SandboxBanner() {
  if (process.env.SANDBOX_MODE !== "1") return null
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-orange-500 text-white text-center py-px px-3 font-medium text-[10px] leading-tight tracking-wide pointer-events-none">
      ⚠️ SANDBOX — NOT PRODUCTION
      <span className="ml-2 font-mono font-normal opacity-90">{buildStampLabel(BUILD_SHA, BUILD_TIME)}</span>
    </div>
  )
}
