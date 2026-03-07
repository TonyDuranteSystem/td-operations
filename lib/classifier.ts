/**
 * Document Classifier — TypeScript port of gdrive-file-classifier.py
 *
 * Classifies documents based on text content using regex rules.
 * Rules work page-by-page: page1 rules check only the first page header,
 * "all" rules check the full text as fallback.
 *
 * Categories:
 *   1 = Company (EIN, Articles, Operating Agreement, etc.)
 *   2 = Contacts (Passport, ID, Proof of Address, ITIN)
 *   3 = Tax (Tax Return, Form 5472, Form 1120, etc.)
 *   4 = Banking (Bank Statement, Application)
 *   5 = Correspondence (Offer, Receipt, IRS Notice, etc.)
 */

// ─── Types ──────────────────────────────────────────────────

export interface ClassificationRule {
  /** Document type name */
  type: string
  /** Category: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence */
  category: number
  /** Patterns that ALL must match (AND logic) */
  patterns: RegExp[]
  /** Patterns that must NOT match (exclusions) */
  excludes: RegExp[]
  /** Scope: which text to check */
  scope: "page1" | "page1-2" | "all"
}

export interface ClassificationResult {
  /** Detected document type (e.g. "Tax Return", "Passport") */
  type: string
  /** Category number (1-5) */
  category: number
  /** Category name */
  categoryName: string
  /** Suggested folder (1. Company, 2. Contacts, etc.) */
  suggestedFolder: string
  /** Confidence: "high" (page1 match) or "medium" (full-text fallback) */
  confidence: "high" | "medium" | "low"
  /** Which rule matched (index) */
  ruleIndex: number
}

// ─── Category Names ─────────────────────────────────────────

const CATEGORY_NAMES: Record<number, string> = {
  1: "Company",
  2: "Contacts",
  3: "Tax",
  4: "Banking",
  5: "Correspondence",
}

const CATEGORY_FOLDERS: Record<number, string> = {
  1: "1. Company",
  2: "2. Contacts",
  3: "3. Tax",
  4: "4. Banking",
  5: "5. Correspondence",
}

// ─── Classification Rules ───────────────────────────────────
// Ported from Python gdrive-file-classifier.py — SAME order, SAME priority

export const RULES: ClassificationRule[] = [
  // ═══ PRIORITÀ 1: Tax Return Package (pagina 1 — cover page) ═══
  {
    type: "Tax Return", category: 3,
    patterns: [/(?:client).?s?\s+copy/i],
    excludes: [], scope: "page1",
  },

  // ═══ PRIORITÀ 2: IRS Notices (pagina 1) ═══
  {
    type: "IRS Notice CP282", category: 5,
    patterns: [/(?:notice\s+)?[CP]{1,2}\s*282/i],
    excludes: [], scope: "page1",
  },
  {
    type: "IRS Notice", category: 5,
    patterns: [/(?:notice\s+(?:CP|P)\s*\d{2,4}|LTR\s+\d+\s*C)/i],
    excludes: [/CP\s*575/i], scope: "page1",
  },

  // ═══ PRIORITÀ 3: EIN Letter CP 575 (page1-2 per intercettare EIN ricevuti via fax) ═══
  {
    type: "EIN Letter (IRS)", category: 1,
    patterns: [/(?:CP\s*575|we\s+(?:have\s+)?assigned\s+you\s+an?\s+employer\s+identification|your\s+(?:new\s+)?employer\s+identification\s+number)/i],
    excludes: [], scope: "page1-2",
  },

  // ═══ PRIORITÀ 3b: IRS Fax generico (solo se NON è un EIN) ═══
  {
    type: "IRS Fax", category: 5,
    patterns: [/fax\s+(?:transmission|cover)/i, /(?:irs|internal\s+revenue)/i],
    excludes: [], scope: "page1",
  },

  // ═══ PRIORITÀ 4: Data Collection / RF Forms ═══
  {
    type: "RF 5472 (Data Collection)", category: 3,
    patterns: [/(?:foreign\s+owned\s+single\s+member|RFForeign|single.member.*tax\s+filing\s+form)/i],
    excludes: [/department\s+of\s+the\s+treasury/i], scope: "page1",
  },
  {
    type: "RF 1065 (Data Collection)", category: 3,
    patterns: [/(?:form\s+1065\s+for\s+multi.member|multi.member.*llc.*partner)/i],
    excludes: [/department\s+of\s+the\s+treasury/i], scope: "page1",
  },
  {
    type: "RF 1120 (Data Collection)", category: 3,
    patterns: [/(?:c.?corp.*(?:data\s+collection|tax.*questionnaire|tax\s+filing))/i],
    excludes: [/department\s+of\s+the\s+treasury/i], scope: "page1",
  },

  // ═══ PRIORITÀ 5: IRS Forms ═══
  {
    type: "Form 8879-PE (E-File Auth)", category: 3,
    patterns: [/form\s+8879/i, /(?:authorization|signature)/i],
    excludes: [/(?:client).?s?\s+copy|government\s+copy/i], scope: "page1",
  },
  {
    type: "Form 7004", category: 3,
    patterns: [/form\s+7004/i, /(?:extension|automatic)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Form 8804-8805 (Partnership Withholding)", category: 3,
    patterns: [/form\s+880[45]/i, /(?:withholding|partnership)/i],
    excludes: [/(?:notice\s+CP|client).?s?\s+copy|form\s+7004/i], scope: "page1-2",
  },
  {
    type: "Form 5472", category: 3,
    patterns: [/form\s+5472/i, /(?:information\s+return|OMB\s+No)/i],
    excludes: [/(?:client).?s?\s+copy|questionnaire/i], scope: "page1",
  },
  {
    type: "Form 1120-F", category: 3,
    patterns: [/form\s+1120.?F/i, /(?:foreign\s+corporation|OMB)/i],
    excludes: [/client.?s?\s+copy/i], scope: "page1",
  },
  {
    type: "Form 1120", category: 3,
    patterns: [/form\s+1120(?!.?F)/i, /(?:corporation\s+income\s+tax|OMB)/i],
    excludes: [/(?:client).?s?\s+copy|questionnaire/i], scope: "page1",
  },
  {
    type: "Form 1065", category: 3,
    patterns: [/form\s+1065/i, /(?:return\s+of\s+partnership|OMB)/i],
    excludes: [/(?:client).?s?\s+copy|multi.member.*questionnaire/i], scope: "page1",
  },
  {
    type: "Form 1040-NR", category: 3,
    patterns: [/form\s+1040.?NR/i],
    excludes: [/client.?s?\s+copy/i], scope: "page1",
  },
  {
    type: "Form W-7", category: 3,
    patterns: [/form\s+w.?7/i, /(?:individual\s+taxpayer|ITIN)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Form SS-4", category: 1,
    patterns: [/form\s+ss.?4/i, /(?:employer\s+identification|OMB)/i],
    excludes: [], scope: "page1",
  },

  // ═══ PRIORITÀ 6: Company documents ═══
  {
    type: "Operating Agreement", category: 1,
    patterns: [/(?:operating\s+agreement|limited\s+liability\s+company\s+agreement)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Articles of Organization", category: 1,
    patterns: [/(?:articles\s+of\s+organization|certificate\s+of\s+formation)/i],
    excludes: [/(?:operating\s+agreement|dissolution|dissolve)/i], scope: "page1",
  },
  {
    type: "Certificate of Good Standing", category: 1,
    patterns: [/(?:hereby\s+certif|I\s+certify).*(?:good\s+standing|exist|status|duly\s+organized)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Registered Agent", category: 1,
    patterns: [/(?:registered\s+agent\s+(?:consent|acceptance|resignation|change|statement|details)|(?:consent|acceptance)\s+(?:of|by)\s+registered\s+agent|your\s+registered\s+agent\s+details|registered\s+agents?\s+(?:inc|llc|service))/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Certificate of Dissolution", category: 1,
    patterns: [/(?:certificate\s+of\s+dissolution|articles\s+of\s+dissolution|dissolv(?:e|ed|ing)\s+(?:the|this)\s+(?:company|llc|corporation))/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Annual Report", category: 1,
    patterns: [/(?:annual\s+report|(?:division\s+of\s+corporations|document\s+number).*(?:annual|report))/i],
    excludes: [/(?:tax\s+return|good\s+standing|hereby\s+certif|payment\s+receipt|receipt\s+confirmation)/i], scope: "page1",
  },
  // Florida Annual Reports — Sunbiz format
  {
    type: "Annual Report", category: 1,
    patterns: [/current\s+principal\s+place\s+of\s+business/i],
    excludes: [/(?:tax\s+return|payment\s+receipt|receipt\s+confirmation)/i], scope: "page1",
  },
  {
    type: "EIN Cancellation Request", category: 1,
    patterns: [/(?:close\s+(?:your\s+)?(?:business\s+)?account|cancel.*ein)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Business License", category: 1,
    patterns: [/(?:business\s+licen[sc]e|licen[sc]e\s+to\s+do\s+business)/i],
    excludes: [], scope: "page1",
  },

  // ═══ PRIORITÀ 7: Full-text fallback ═══
  {
    type: "Tax Return", category: 3,
    patterns: [/(?:prepared\s+for.*tax\s+return|enclosed\s+(?:is\s+)?your.*return)/i],
    excludes: [], scope: "all",
  },

  // ─── Banking ───
  {
    type: "Bank Statement", category: 4,
    patterns: [/(?:bank\s+statement|account\s+statement|statement\s+period|(?:USD|EUR|GBP)\s+statement)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Bank Statement", category: 4,
    patterns: [/(?:account\s+(?:owner|details|number)|(?:wise|mercury|chase|relay|novo)\b)/i],
    excludes: [/(?:tax\s+return|annual\s+report|form\s+\d)/i], scope: "page1",
  },
  {
    type: "Bank Application", category: 4,
    patterns: [/(?:account\s+opening|bank.*application|new\s+account.*form)/i],
    excludes: [], scope: "page1",
  },

  // ─── Contacts / ID ───
  {
    type: "Passport", category: 2,
    patterns: [/(?:passport|passeport|passaporto)/i],
    excludes: [/(?:form\s+\d|department\s+of\s+the\s+treasury|internal\s+revenue|bank\s+statement|receipt|ein\s+|employer\s+identification)/i], scope: "page1",
  },
  {
    type: "ID Document", category: 2,
    patterns: [/(?:driver.?s?\s+licen[sc]e|identity\s+card|carta\s+d.?identit)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Proof of Address", category: 2,
    patterns: [/(?:proof\s+of\s+address|estratto\s+conto|utility\s+bill|bank\s+reference\s+letter)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Utility Bill", category: 2,
    patterns: [/(?:utility\s+bill|electric\s+(?:bill|statement))/i],
    excludes: [], scope: "page1",
  },

  // ─── Company (more) ───
  {
    type: "BOI Report", category: 2, // NB: cat 2 (Contacts) — confirmed by Antonio
    patterns: [/(?:beneficial\s+ownership|boi\b|fincen\b)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Office Lease", category: 1,
    patterns: [/(?:rent\s+office\s+agreement|office\s+lease|(?:virtual\s+)?office\s+(?:agreement|contract)|lease\s+agreement)/i],
    excludes: [], scope: "page1-2",
  },
  {
    type: "Profit & Loss Statement", category: 1,
    patterns: [/(?:profit\s*(?:&|and)\s*loss|income\s+statement|P\s*&\s*L\s+statement)/i],
    excludes: [], scope: "page1",
  },

  // ─── Correspondence ───
  {
    type: "Offer Letter", category: 5,
    patterns: [/(?:proposta\s+(?:commerciale|economica)|offerta|proposal|engagement\s+letter|tony\s+durante\s+llc.*(?:serviz|pric|fee))/i],
    excludes: [], scope: "page1",
  },
  {
    type: "IRS E-File Acknowledgment", category: 5,
    patterns: [/(?:acknowledg(?:e)?ment.*(?:entit|file|electronic)|e.?file\s+(?:ack|confirm)|file\s+returns?\s+electronically)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "ITIN Letter", category: 2,
    patterns: [/(?:individual\s+taxpayer\s+identification|ITIN\s+(?:application|letter|assign))/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Fax Confirmation", category: 5,
    patterns: [/(?:fax\s+(?:transmission|confirmation|cover)|facsimile)/i],
    excludes: [], scope: "page1",
  },
  {
    type: "Receipt", category: 5,
    patterns: [/(?:(?:payment\s+)?receipt|ricevuta|payment\s+(?:confirmation|received))/i],
    excludes: [/tax\s+return/i], scope: "page1",
  },
]

// ─── Classification Engine ──────────────────────────────────

/**
 * Get text for a rule scope from pages array.
 */
function getTextForScope(pages: string[], scope: string): string {
  if (scope === "page1") {
    return pages[0] || ""
  }
  if (scope === "page1-2") {
    return (pages[0] || "") + "\n" + (pages[1] || "")
  }
  // "all" — concatenate all pages
  return pages.join("\n")
}

/**
 * Classify a document based on its text content.
 * Pass per-page text for best results (page1 rules are more accurate).
 *
 * @param pages Array of text per page (pages[0] = page 1). Can be a single-element array with full text.
 * @returns Classification result or null if no match
 */
export function classifyDocument(pages: string[]): ClassificationResult | null {
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i]
    const text = getTextForScope(pages, rule.scope)

    if (!text) continue

    // Check ALL patterns match (AND logic)
    const allPatternsMatch = rule.patterns.every(p => p.test(text))
    if (!allPatternsMatch) continue

    // Check NO excludes match
    const anyExcludeMatches = rule.excludes.some(p => p.test(text))
    if (anyExcludeMatches) continue

    // Match found!
    return {
      type: rule.type,
      category: rule.category,
      categoryName: CATEGORY_NAMES[rule.category] || "Unknown",
      suggestedFolder: CATEGORY_FOLDERS[rule.category] || "Unknown",
      confidence: rule.scope === "all" ? "medium" : "high",
      ruleIndex: i,
    }
  }

  return null
}

/**
 * Classify a document using just the filename (no content).
 * Less accurate but instant — useful for quick filtering.
 */
export function classifyByFilename(filename: string): ClassificationResult | null {
  const name = filename.toLowerCase()

  // Quick filename-based rules
  const filenameRules: Array<{ pattern: RegExp; type: string; category: number }> = [
    { pattern: /tax\s*return/i, type: "Tax Return", category: 3 },
    { pattern: /form\s*5472/i, type: "Form 5472", category: 3 },
    { pattern: /form\s*1120/i, type: "Form 1120", category: 3 },
    { pattern: /form\s*1065/i, type: "Form 1065", category: 3 },
    { pattern: /form\s*7004/i, type: "Form 7004", category: 3 },
    { pattern: /form\s*8879/i, type: "Form 8879-PE (E-File Auth)", category: 3 },
    { pattern: /form\s*w.?7/i, type: "Form W-7", category: 3 },
    { pattern: /form\s*ss.?4/i, type: "Form SS-4", category: 1 },
    { pattern: /ein\s*letter/i, type: "EIN Letter (IRS)", category: 1 },
    { pattern: /articles?\s*(?:of\s*)?org/i, type: "Articles of Organization", category: 1 },
    { pattern: /operating\s*agree/i, type: "Operating Agreement", category: 1 },
    { pattern: /good\s*standing/i, type: "Certificate of Good Standing", category: 1 },
    { pattern: /annual\s*report/i, type: "Annual Report", category: 1 },
    { pattern: /passport/i, type: "Passport", category: 2 },
    { pattern: /(?:driver|id\s*card|identity)/i, type: "ID Document", category: 2 },
    { pattern: /bank\s*statement/i, type: "Bank Statement", category: 4 },
    { pattern: /registered\s*agent/i, type: "Registered Agent", category: 1 },
    { pattern: /itin/i, type: "ITIN Letter", category: 2 },
    { pattern: /(?:boi|beneficial\s*owner)/i, type: "BOI Report", category: 2 },
    { pattern: /(?:offer|proposta|offerta)/i, type: "Offer Letter", category: 5 },
    { pattern: /receipt|ricevuta/i, type: "Receipt", category: 5 },
  ]

  for (const rule of filenameRules) {
    if (rule.pattern.test(name)) {
      return {
        type: rule.type,
        category: rule.category,
        categoryName: CATEGORY_NAMES[rule.category] || "Unknown",
        suggestedFolder: CATEGORY_FOLDERS[rule.category] || "Unknown",
        confidence: "low",
        ruleIndex: -1,
      }
    }
  }

  return null
}
