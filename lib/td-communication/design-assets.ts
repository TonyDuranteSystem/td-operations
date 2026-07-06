/**
 * TD Communication — design-asset save validation (Phase 12).
 *
 * Pure validation for the ISOLATED design-tools save path. Tool outputs are a
 * narrow, known set — a mockup PNG or an asset-kit ZIP — so this is a tight
 * allow-list, separate from the manual-upload `validateDeliverable` (which does
 * NOT allow zip). Keeping it separate means the shared deliverables validation
 * is untouched.
 *
 * No DB / no I/O — client-safe, unit-tested (R086).
 */

import { getExtension, isDesignAssetType, type DesignAssetType } from './deliverables'

export const DESIGN_ASSET_MAX_MB = 100
export const DESIGN_ASSET_MAX_BYTES = DESIGN_ASSET_MAX_MB * 1024 * 1024

/**
 * Only what the tools actually produce: PNG (mockups) + ZIP (asset kits) + SVG/PNG
 * (geometry specimens). SVG is allowed ONLY for the geometry type — it is generated
 * exclusively from the pure XML-escaped template (renderGeometrySvg), never from
 * user input, and is served inline via <img> (script-inert) from the private bucket.
 */
export const DESIGN_ASSET_ALLOWED_EXTENSIONS = new Set<string>(['png', 'zip', 'svg'])

/** Which extension each tool type is allowed to save (defense in depth). */
const TYPE_EXTENSIONS: Record<DesignAssetType, ReadonlySet<string>> = {
  mockup: new Set(['png']),
  asset_kit: new Set(['zip']),
  geometry: new Set(['svg', 'png']),
}

/**
 * Validate a design-asset save. Returns a user-friendly message, or null when
 * allowed. Checks the size cap, the allow-list, and that the extension matches
 * the declared tool type.
 */
export function validateDesignAsset(
  fileName: string,
  sizeBytes: number,
  type: unknown,
): string | null {
  if (!isDesignAssetType(type)) {
    return 'Invalid design-asset type.'
  }
  if (sizeBytes > DESIGN_ASSET_MAX_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    return `File too large: ${mb} MB. Maximum allowed: ${DESIGN_ASSET_MAX_MB} MB.`
  }
  const ext = getExtension(fileName)
  if (!ext || !DESIGN_ASSET_ALLOWED_EXTENSIONS.has(ext)) {
    return 'Only PNG, SVG and ZIP files can be saved from the design tools.'
  }
  if (!TYPE_EXTENSIONS[type].has(ext)) {
    const allowed = Array.from(TYPE_EXTENSIONS[type]).map((e) => e.toUpperCase()).join(' or ')
    const label = type === 'mockup' ? 'A mockup' : type === 'asset_kit' ? 'An asset kit' : 'A geometry export'
    return `${label} must be a ${allowed}.`
  }
  return null
}
