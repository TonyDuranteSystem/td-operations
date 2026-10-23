/**
 * Publishing a new TD Storage app version from the CRM (the owner's "Publish new version" panel on /tools/storage-app — Antonio, 2026-10-22:
 * "I'm not the expert", so no database key and no terminal). The private update key never leaves the Mac mini: `scripts/storage-app-release-package.ts`
 * signs the zip THERE and writes a small package file; the CRM only ever holds the PUBLIC key and uses it to check the upload before accepting it.
 * A release is always stored PAUSED (not offered) — a separate step offers it to the Macs.
 */
import { createPublicKey, verify } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { RELEASE_BUCKET, RELEASE_KEY, type Release, parseRelease } from "./release"

/** The PUBLIC half of the update key (the same value baked into every app as SUPublicEDKey). Public by nature — safe in code. */
export const UPDATE_PUBLIC_KEY = "QyZK2Ugq/n7g5wnBwo0YzjQUo7PVjdINdK4KXxWyYu0="
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

/** PURE: is `signature` (base64, as Sparkle prints it) a valid Ed25519 signature of exactly these bytes under the public key? Never throws. */
export function verifyUpdateSignature(file: Uint8Array, signature: string, publicKey: string = UPDATE_PUBLIC_KEY): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64")
    const sig = Buffer.from(signature, "base64")
    if (raw.length !== 32 || sig.length !== 64) return false
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" })
    return verify(null, file, key, sig)
  } catch { return false }
}

export interface ReleasePackage { version: string; build: number; edSignature: string; length: number; notes: string; minSystem: string }

/** PURE: the small file the signing script writes next to the zip. Anything missing or malformed → null. */
export function parseReleasePackage(raw: unknown): ReleasePackage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.kind !== "td-storage-release") return null
  const rel = parseRelease({ version: r.version, build: r.build, edSignature: r.edSignature, length: r.length, path: "x/x.zip", notes: r.notes, minSystem: r.minSystem, enabled: false })
  if (!rel) return null
  return { version: rel.version, build: rel.build, edSignature: rel.edSignature, length: rel.length, notes: rel.notes.slice(0, 2000), minSystem: rel.minSystem }
}

/** PURE: where a version's zip lives. Decided HERE from the version number — never taken from the browser. */
export const zipPathFor = (version: string) => `storage-app/${version}/TDStorage-${version}.zip`

/** PURE: a published build number must always go up (Sparkle only ever moves forward). */
export const buildIsNewer = (current: Release | null, build: number) => !current || build > current.build

export async function ensureBucket(): Promise<void> {
  const { data } = await supabaseAdmin.storage.listBuckets()
  if (data?.some((b) => b.name === RELEASE_BUCKET)) return
  const { error } = await supabaseAdmin.storage.createBucket(RELEASE_BUCKET, { public: false })
  if (error && !/already exists/i.test(error.message)) throw new Error(`Could not prepare the storage place: ${error.message}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings value is jsonb
const settingsTable = () => (supabaseAdmin as any).from("app_settings")

export async function writeRelease(value: Record<string, unknown>): Promise<void> {
  const { error } = await settingsTable().upsert({ key: RELEASE_KEY, value, updated_at: new Date().toISOString() })
  if (error) throw new Error("Could not save the release record.")
}

/** Check the uploaded zip (size + signature) and store the release record PAUSED. Throws an Error with a plain-English message on any problem. */
export async function acceptUpload(pkg: ReleasePackage, current: Release | null, by: string): Promise<Release> {
  if (!buildIsNewer(current, pkg.build)) throw new Error(`Build ${pkg.build} is not newer than the published build ${current?.build}. Make a new build number.`)
  const path = zipPathFor(pkg.version)
  const { data, error } = await supabaseAdmin.storage.from(RELEASE_BUCKET).download(path)
  if (error || !data) throw new Error("The zip did not arrive. Upload it again.")
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (bytes.length !== pkg.length) throw new Error(`The zip is ${bytes.length} bytes but the package file says ${pkg.length}. They do not belong together.`)
  if (!verifyUpdateSignature(bytes, pkg.edSignature)) throw new Error("The signature does not match the zip and our update key. Nothing was published.")
  const value = { ...pkg, path, enabled: false, rolloutPercent: 100, publishedAt: new Date().toISOString(), publishedBy: by }
  await writeRelease(value)
  const saved = parseRelease(value)
  if (!saved) throw new Error("The release record is not valid.")
  return saved
}

/** Offer the current release to the Macs (or pause it); optionally set the roll-out share. Needs a published release. */
export async function setOffering(current: Release | null, change: { enabled?: boolean; rolloutPercent?: number }, by: string): Promise<Release> {
  if (!current) throw new Error("No version is published yet.")
  const value = {
    ...current,
    enabled: change.enabled ?? current.enabled,
    rolloutPercent: change.rolloutPercent === undefined ? current.rolloutPercent : Math.min(100, Math.max(0, Math.round(change.rolloutPercent))),
    updatedBy: by,
  }
  await writeRelease(value)
  const saved = parseRelease(value)
  if (!saved) throw new Error("The release record is not valid.")
  return saved
}
