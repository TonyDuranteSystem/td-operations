import { releaseIdFrom } from '@/lib/release/release-check'

/**
 * THIS deployment's own release id, baked into the bundle at BUILD time (Next.js inlines the two NEXT_PUBLIC_ names below as written —
 * keep them literal). In the browser it is "the release this page was loaded with"; in /api/release (server bundle of the SAME
 * deployment) it is "the release this server is". They agree inside one deployment and differ across deployments — that difference
 * is the whole signal.
 *
 * Where the values come from: next.config.js maps Vercel's commit into NEXT_PUBLIC_BUILD_SHA for production builds; the sandbox's
 * scripts/deploy-sandbox.sh injects both sha and time itself (that project is git-disconnected). Neither set (local dev) → '' → the
 * check stays off.
 */
export const OWN_RELEASE_ID = releaseIdFrom(process.env.NEXT_PUBLIC_BUILD_SHA, process.env.NEXT_PUBLIC_BUILD_TIME)

/**
 * The newest release note this build carries (dev job 616dc839; next.config.js reads content/releases/ at build time). A page sends it
 * as `since` to /api/release/notes so the update bar can say what is new BEYOND what the page already has. Empty = a build with no
 * notes → the bar simply offers no description. Keep the name literal (Next.js only inlines NEXT_PUBLIC names as written).
 */
export const OWN_NEWEST_NOTE = (process.env.NEXT_PUBLIC_NEWEST_NOTE ?? '').trim()
