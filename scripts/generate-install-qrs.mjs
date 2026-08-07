/**
 * Regenerates the committed install-page QR SVGs (Phase 4, dev job 8f38add1).
 *
 *   node scripts/generate-install-qrs.mjs
 *
 * Committed static assets exist ONLY for placements that cannot run JS
 * (print, email signature, the guide page image). The desktop install-page
 * QR is rendered at request time and does NOT use these files.
 *
 * ⚠️ The encoded URL is frozen into pixels — invisible to the pre-push
 * domain guard (which scans source text) and unaffected by env overrides.
 * These QRs ALWAYS point at the production portal domain on purpose: a
 * printed card or signature scan must never land on the sandbox. R015
 * guarantees the domain never disappears. After ANY regeneration, QA must
 * physically scan each QR before it ships (council/SE finding).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import QRCode from 'qrcode'

// Mirrors PORTAL_BASE_URL in lib/config.ts (production value, no env
// override — see the header warning about sandbox scans).
const PORTAL_BASE_URL = 'https://portal.tonydurante.us'

// One asset per NON-JS channel. Digital placements use plain links instead.
const CHANNELS = ['qr-print', 'email-sig', 'guide']

const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'install-qr',
)

await mkdir(outDir, { recursive: true })
for (const src of CHANNELS) {
  const url = `${PORTAL_BASE_URL}/portal/install?src=${src}`
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    width: 240,
    errorCorrectionLevel: 'M',
    color: { dark: '#18181b', light: '#ffffff' },
  })
  const file = path.join(outDir, `${src}.svg`)
  await writeFile(file, svg, 'utf8')
  console.log(`wrote ${file} -> ${url}`)
}
