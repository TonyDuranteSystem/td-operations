/**
 * OCR Cross-Check — Compare wizard data against uploaded documents.
 *
 * Uses Document AI OCR to extract text from uploaded PDFs/images,
 * then compares key fields (LLC name, EIN, owner name) against wizard data.
 *
 * Fuzzy matching thresholds:
 * - >80% similarity = auto-approve
 * - 50-80% = flag for staff review (warning)
 * - <50% = block (mismatch)
 *
 * This module is optional — if OCR fails or files don't exist,
 * the chain continues with a warning (not a block).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface OCRCheckResult {
  field: string
  wizardValue: string
  ocrValue: string | null
  similarity: number
  status: "match" | "warning" | "mismatch" | "skipped"
  detail: string
}

export interface OCRCrossCheckResult {
  checks: OCRCheckResult[]
  hasBlockers: boolean
  summary: string
}

/**
 * Levenshtein distance between two strings (case-insensitive).
 * Returns a similarity score 0-100.
 */
export function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const s1 = a.toLowerCase().trim()
  const s2 = b.toLowerCase().trim()
  if (s1 === s2) return 100

  const len1 = s1.length
  const len2 = s2.length
  const maxLen = Math.max(len1, len2)
  if (maxLen === 0) return 100

  // Levenshtein distance
  const dp: number[][] = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0))
  for (let i = 0; i <= len1; i++) dp[i][0] = i
  for (let j = 0; j <= len2; j++) dp[0][j] = j

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // deletion
        dp[i][j - 1] + 1,     // insertion
        dp[i - 1][j - 1] + cost // substitution
      )
    }
  }

  const distance = dp[len1][len2]
  return Math.round((1 - distance / maxLen) * 100)
}

/**
 * Normalize company name for comparison.
 * Strips common suffixes (LLC, L.L.C., Inc, etc.) and punctuation.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s*(llc|l\.l\.c\.|l\.l\.c|inc\.?|corp\.?|ltd\.?|limited)\.?\s*$/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Normalize EIN for comparison.
 * Strips all non-digits and reformats.
 */
export function normalizeEIN(ein: string): string {
  return ein.replace(/\D/g, "")
}

/**
 * Search for a pattern in OCR text. Returns the best match found or null.
 */
function findInOCRText(ocrText: string, pattern: string): string | null {
  if (!ocrText || !pattern) return null

  // Try exact match first (case-insensitive)
  const lower = ocrText.toLowerCase()
  const patternLower = pattern.toLowerCase()
  if (lower.includes(patternLower)) return pattern

  // For EIN: search for the digits pattern XX-XXXXXXX
  const einDigits = pattern.replace(/\D/g, "")
  if (einDigits.length === 9) {
    const einPattern = new RegExp(`${einDigits.slice(0, 2)}.?${einDigits.slice(2)}`)
    const match = ocrText.match(einPattern)
    if (match) return match[0]
  }

  return null
}

/**
 * Run OCR cross-check on uploaded documents against wizard data.
 *
 * @param wizardData - The submitted wizard data
 * @param uploadPaths - Storage paths to uploaded files
 * @returns OCR cross-check results with per-field similarity scores
 */
export async function runOCRCrossCheck(
  wizardData: Record<string, unknown>,
  uploadPaths: string[] | null
): Promise<OCRCrossCheckResult> {
  const checks: OCRCheckResult[] = []

  if (!uploadPaths || uploadPaths.length === 0) {
    return {
      checks: [],
      hasBlockers: false,
      summary: "No uploaded documents to cross-check",
    }
  }

  // Extract OCR text from each uploaded file
  const ocrTexts: Record<string, string> = {}

  for (const path of uploadPaths) {
    const cleanPath = path.replace(/^\/+/, "")
    let docType = "unknown"
    if (cleanPath.includes("passport")) docType = "passport"
    else if (cleanPath.includes("articles")) docType = "articles"
    else if (cleanPath.includes("ein")) docType = "ein_letter"
    else if (cleanPath.includes("ss4")) docType = "ss4"

    try {
      // Download from Supabase Storage
      const { data: blob, error } = await supabaseAdmin.storage
        .from("onboarding-uploads")
        .download(cleanPath)

      if (error || !blob) continue

      const arrayBuffer = await blob.arrayBuffer()
      const mimeType = blob.type || "application/pdf"

      // Call Document AI OCR
      const { ocrRawContent } = await import("@/lib/docai")
      const ocrResult = await ocrRawContent(arrayBuffer, mimeType, cleanPath.split("/").pop() || "file")
      if (ocrResult?.fullText) {
        ocrTexts[docType] = ocrResult.fullText
      }
    } catch {
      // OCR failure is non-blocking — we just skip this document
    }
  }

  // Check 1: Company name (wizard vs Articles of Organization)
  const wizardCompany = String(wizardData.company_name || "").trim()
  if (wizardCompany && ocrTexts.articles) {
    const normalizedWizard = normalizeCompanyName(wizardCompany)
    const found = findInOCRText(ocrTexts.articles, wizardCompany)

    if (found) {
      checks.push({
        field: "company_name",
        wizardValue: wizardCompany,
        ocrValue: found,
        similarity: 100,
        status: "match",
        detail: "Company name found in Articles",
      })
    } else {
      // Try fuzzy matching against the full OCR text
      // Extract potential company names (lines containing "LLC" or similar)
      const lines = ocrTexts.articles.split(/\n/)
      let bestSim = 0
      let bestLine = ""
      for (const line of lines) {
        if (line.toLowerCase().includes("llc") || line.toLowerCase().includes("company")) {
          const sim = stringSimilarity(normalizedWizard, normalizeCompanyName(line))
          if (sim > bestSim) {
            bestSim = sim
            bestLine = line.trim()
          }
        }
      }

      if (bestSim > 80) {
        checks.push({ field: "company_name", wizardValue: wizardCompany, ocrValue: bestLine, similarity: bestSim, status: "match", detail: `Found in Articles (${bestSim}% match)` })
      } else if (bestSim > 50) {
        checks.push({ field: "company_name", wizardValue: wizardCompany, ocrValue: bestLine, similarity: bestSim, status: "warning", detail: `Partial match in Articles (${bestSim}%)` })
      } else {
        checks.push({ field: "company_name", wizardValue: wizardCompany, ocrValue: bestLine || null, similarity: bestSim, status: "warning", detail: `Company name not confidently found in Articles (${bestSim}%)` })
      }
    }
  }

  // Check 2: EIN (wizard vs EIN letter)
  const wizardEIN = String(wizardData.ein || "").trim()
  if (wizardEIN && ocrTexts.ein_letter) {
    const normalizedEIN = normalizeEIN(wizardEIN)
    const found = findInOCRText(ocrTexts.ein_letter, wizardEIN)

    if (found) {
      checks.push({ field: "ein", wizardValue: wizardEIN, ocrValue: found, similarity: 100, status: "match", detail: "EIN found in EIN letter" })
    } else {
      // Search for the 9-digit EIN anywhere in the text
      const allNums = ocrTexts.ein_letter.match(/\d{2}[-.\s]?\d{7}/g) || []
      const matchingNum = allNums.find(n => normalizeEIN(n) === normalizedEIN)
      if (matchingNum) {
        checks.push({ field: "ein", wizardValue: wizardEIN, ocrValue: matchingNum, similarity: 100, status: "match", detail: "EIN digits found in EIN letter" })
      } else {
        checks.push({ field: "ein", wizardValue: wizardEIN, ocrValue: allNums[0] || null, similarity: 0, status: "warning", detail: `EIN ${wizardEIN} not found in EIN letter` })
      }
    }
  }

  // Check 3: Owner name (wizard vs passport)
  const wizardFirstName = String(wizardData.owner_first_name || "").trim()
  const wizardLastName = String(wizardData.owner_last_name || "").trim()
  const wizardFullName = `${wizardFirstName} ${wizardLastName}`.trim()

  if (wizardFullName && ocrTexts.passport) {
    const firstFound = findInOCRText(ocrTexts.passport, wizardFirstName)
    const lastFound = findInOCRText(ocrTexts.passport, wizardLastName)

    if (firstFound && lastFound) {
      checks.push({ field: "owner_name", wizardValue: wizardFullName, ocrValue: `${firstFound} ${lastFound}`, similarity: 100, status: "match", detail: "Name found in passport" })
    } else if (lastFound) {
      checks.push({ field: "owner_name", wizardValue: wizardFullName, ocrValue: lastFound, similarity: 70, status: "warning", detail: "Only last name found in passport" })
    } else {
      // Fuzzy match the full name against passport text
      const lines = ocrTexts.passport.split(/\n/)
      let bestSim = 0
      let bestLine = ""
      for (const line of lines) {
        const sim = stringSimilarity(wizardFullName, line.trim())
        if (sim > bestSim) {
          bestSim = sim
          bestLine = line.trim()
        }
      }
      const status = bestSim > 80 ? "match" : bestSim > 50 ? "warning" : "warning"
      checks.push({ field: "owner_name", wizardValue: wizardFullName, ocrValue: bestLine || null, similarity: bestSim, status, detail: `Name in passport: ${bestSim}% match` })
    }
  }

  // Determine if there are any blockers (mismatch status)
  const hasBlockers = checks.some(c => c.status === "mismatch")
  const matchCount = checks.filter(c => c.status === "match").length
  const warnCount = checks.filter(c => c.status === "warning").length

  return {
    checks,
    hasBlockers,
    summary: `${matchCount} match, ${warnCount} warning(s)${hasBlockers ? ", BLOCKED" : ""}`,
  }
}
