/**
 * Categorization rules for the owner's own books — DATA, not logic.
 *
 * Every rule here was written by reading Tony Durante LLC's real 2025 statements,
 * merchant by merchant. NOTHING is inherited from Zoho, from the bookkeeper, or
 * from the bank's own category column — Antonio's standing instruction for this
 * rebuild, and the statements prove why: on Chase 9279 the bank files 60 Facebook
 * ad charges under "Professional Services" and the $11,225 of Wyoming Secretary of
 * State filings under "Bills & Utilities". Inheriting that would put client filing
 * costs in overhead and advertising in consulting.
 *
 * Two properties this file must keep:
 *  1. ORDERED — first match wins, specific before general. "APPLE.COM/BILL" must be
 *     read before a general "APPLE" rule, or the specific one never fires. A general
 *     rule silently swallowing a specific one already corrupted one pass of this work.
 *  2. PURE — matching is a function of (description, amount) only, so it is testable
 *     without a database and reviewable without running anything.
 *
 * This is the seed for the catalog-backed vendor rules planned for the books
 * operations phase; keeping it as data now means that move is a migration, not a
 * rewrite.
 */
import type { OwnerCategory } from '@/lib/owner-finance'

export interface OwnerBooksRule {
  /** Matched case-insensitively against the transaction description. */
  match: RegExp
  category: OwnerCategory
  subcategory: string
  /** Why this classification — read by a human reviewing the books, not by code. */
  why: string
  /**
   * Some rules only make sense on one side of the ledger. A "PAYMENT THANK YOU" on
   * a card is money arriving to pay the card down; the same words could not mean
   * that on an outflow. Where direction carries meaning, it is stated.
   */
  direction?: 'in' | 'out'
  /**
   * Restrict a rule to certain account types. A positive amount means a refund on a
   * CARD and a deposit in a CHECKING account — opposite things, so a rule that reads
   * direction alone must say which kind of account it is talking about.
   */
  accountTypes?: string[]
  /**
   * A rule that is right EXCEPT for a known family of exceptions. Cheaper and far
   * more readable than a negative lookahead inside an already-long pattern.
   */
  exclude?: RegExp
}

export interface OwnerBooksMatch {
  category: OwnerCategory
  subcategory: string
  why: string
}

/**
 * ORDER MATTERS. Read top to bottom; the first match wins.
 */
export const OWNER_BOOKS_RULES: OwnerBooksRule[] = [
  // ── Paying the card down ───────────────────────────────────────────────────
  // Money moving from Antonio's own checking account to his own card. It is NOT
  // income, and the checking account records the same movement as an outflow —
  // booking either side to the P&L would invent revenue or double an expense.
  {
    match: /PAYMENT THANK YOU|AUTOPAY PAYMENT|ONLINE PAYMENT THANK/i,
    category: 'transfer', subcategory: 'card_payment', direction: 'in',
    why: 'Own money paying down the card — the paying account records the other side.',
  },

  // ── Antonio's money moving between Antonio's own accounts ─────────────────
  // THE MOST EXPENSIVE MISTAKE AVAILABLE IN THIS DATASET. Chase checking receives
  // large ACH credits that are Antonio's OTHER business accounts sweeping into
  // Chase — Airwallex ("NTE*ZZZ*Airwallex") and Mercury ("From Tony Durante LLC via
  // mercury.com"). Each of those accounts is, or is being, loaded into these books
  // with its own rows, so counting the arrival as income reports the same client
  // money twice: about $150,000 from Airwallex and $210,000 from Mercury.
  //
  // The tell is the originator — Tony Durante LLC paying Tony Durante LLC.
  {
    // ORIG ID:1371913769 is Airwallex's own ACH originator id. It is the reliable
    // tell: one sweep in April carries the entry description "Chase" rather than
    // "Airwallex", and matching on the words alone missed $12,400 of it.
    match: /CO ENTRY DESCR:\s*airwallex|NTE\*ZZZ\*airwallex|ORIG CO NAME:AIRWALLEX|ORIG ID:1371913769|MercuryACH|via mercury\.c|ORIG CO NAME:RELAY|RELAY FINANCIAL|ZELLE PAYMENT TO FIRSTCITIZENBANK/i,
    category: 'transfer', subcategory: 'own_account',
    why: "Own money swept in from another of Antonio's accounts, which is itself in these books.",
  },
  // Paying a card from the bank — the other side of the card statements' own
  // "PAYMENT THANK YOU" rows. Both sides must be transfers or the payment is
  // counted as an expense on top of the purchases it settled.
  {
    match: /PAYMENT TO CHASE CARD|ORIG CO NAME:AMERICAN EXPRESS|APPLECARD GSBANK|ORIG CO NAME:BEST BUY|CITI(CTP|AUTFDR)/i,
    category: 'transfer', subcategory: 'card_payment',
    why: 'Paying a credit card from the bank account.',
  },

  // Antonio moving money out to another of his own accounts: he is both the
  // originator and the beneficiary, with a bare "TRANSFER" description.
  {
    match: /ORIG CO NAME:TONY DURANTE LLC[\s\S]*CO ENTRY DESCR:TRANSFER/i,
    category: 'transfer', subcategory: 'own_account',
    why: 'Own-account transfer — Tony Durante LLC on both sides.',
  },

  // Money arriving from Antonio himself. PROVEN, not inferred: First Citizens 5820
  // shows "Zelle TONY DURANTE L" for $1,000 on 4 June and $2,000 on 27 June, and
  // Chase checking shows "Zelle payment to FirstCitizenBank" for the same amounts on
  // the same two days. Both sides are the same money.
  {
    match: /ZELLE (PAYMENT )?(FROM )?TONY DURANTE|ZELLE (PAYMENT )?(FROM )?ANTONIO DURANTE/i,
    category: 'transfer', subcategory: 'own_account', direction: 'in',
    why: "Own money arriving from another of Antonio's accounts.",
  },

  // ── A merchant giving money BACK ───────────────────────────────────────────
  // On a credit card there are only two ways money can come IN: you paid the card
  // (matched above), or a merchant reversed a charge. Everything else positive here
  // is a refund, and it must be booked as one rather than as the merchant's own
  // expense category — a positive row sitting in "insurance" or "software" reads as
  // spending and inflates the expense it was supposed to cancel.
  //
  // FOUND ON THE REAL DATA, not theoretical: Chase 9279 carries a $1,076 Root
  // Insurance charge and its two reversing credits, plus a $65 Intuit adjustment and
  // a Grammarly credit. Without this rule the card reports $1,076 of insurance it
  // never actually paid.
  {
    match: /.*/,
    category: 'refund', subcategory: 'merchant_refund', direction: 'in',
    accountTypes: ['credit_card'],
    why: 'Money back on a card — a reversed or refunded charge.',
  },

  // ── Cost of delivering the service (COGS) ──────────────────────────────────
  // State agencies charging for a CLIENT's formation, annual report or amendment.
  // These scale with client volume, which is what makes them cost of sales rather
  // than overhead — 141 Wyoming charges in one year is client work, not TD's own
  // single annual report.
  {
    match: /WYOMING SECRETARY OF STAT|WY SECRETARY OF STATE/i,
    category: 'cogs', subcategory: 'state_filing_fees',
    why: 'Wyoming state filing fee paid on a client formation/renewal.',
  },
  {
    match: /DELAWARE CORP|DIVISION OF CORP|SUNBIZ|CORPORATE FILINGS LLC|NIC\*/i,
    category: 'cogs', subcategory: 'state_filing_fees',
    why: 'State/registry filing fee paid on a client filing.',
  },
  {
    match: /USPS CHANGE OF ADDRESS/i,
    category: 'cogs', subcategory: 'client_mail',
    why: 'Mail redirection set up for a client address.',
  },

  // ── Payroll ────────────────────────────────────────────────────────────────
  // Gusto debits the total of wages, withheld taxes and its own fee as one ACH, so
  // this is deliberately ONE line rather than a split invented from a lump sum.
  // Antonio is the only person on payroll, which makes this officer compensation on
  // the S-corp return.
  {
    match: /ORIG CO NAME:GUSTO|\bGUSTO\b/i,
    category: 'expense', subcategory: 'payroll',
    why: 'Payroll run — wages, withheld tax and the provider fee in one debit.',
  },

  // ── People who do the client work ─────────────────────────────────────────
  {
    match: /ZELLE PAYMENT TO LUCA/i,
    category: 'cogs', subcategory: 'contractor',
    why: 'Paid to Luca for client work — a direct cost of delivering the service.',
  },

  // ── Money out to the members ──────────────────────────────────────────────
  // Jodi holds half the company. Money sent to her is a distribution, never an
  // expense — it is the profit being split, not a cost of earning it.
  {
    match: /ZELLE PAYMENT TO JODI/i,
    category: 'distribution', subcategory: 'member_distribution',
    why: 'Distribution to the other 50% member.',
  },

  // ── The house, the car and the family ─────────────────────────────────────
  {
    match: /HOUSECHASE|ORIG CO NAME:ALLY\b|SUNCOAST CU LOAN|SUNCOASTCU|ZELLE PAYMENT TO JANET/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Personal: mortgage, car loan or family transfer paid from the company account.',
  },

  // ── Advertising ────────────────────────────────────────────────────────────
  // The bank files these under "Professional Services". They are Meta ad spend.
  {
    match: /FACEBK|FACEBOOK|META PLATFORMS|GOOGLE ADS|ADWORDS/i,
    category: 'expense', subcategory: 'advertising',
    why: 'Paid advertising.',
  },

  // ── Software and subscriptions ─────────────────────────────────────────────
  {
    // \b on AWS: a bare token would also match inside LAWSON, and a merchant
    // swallowed by the wrong rule is invisible.
    // Wise is deliberately ABSENT — it moves money rather than selling software, so
    // its rows must not be booked as an expense.
    match: /ZOHO|INTUIT|QBOOKS|GSUITE|GOOGLE \*|DROPBOX|AMAZON WEB SERVICES|\bAWS\b|CALENDLY|GRAMMARLY|HOSTINGER|PUBBLIE|TENORSHARE|APPLE\.COM|PUBLICRECORDS|SHIPSTATION|STAMPS\.COM|DRAKE SOFTWARE|PADDLE\.NET|\bN8N\b|ZOOM\.|HEYGEN|ANTHROPIC|OPENAI|ELEVENLABS|CANVA|NOTION\.SO/i,
    category: 'expense', subcategory: 'software',
    why: 'Software subscription or cloud service.',
  },

  // ── Office supplies ────────────────────────────────────────────────────────
  {
    match: /STAPLES|OFFICE DEPOT|OFFICEMAX/i,
    category: 'expense', subcategory: 'office_supplies',
    why: 'Office supplies.',
  },

  // ── Communications ─────────────────────────────────────────────────────────
  {
    match: /TELLO|SPECTRUM|VERIZON|AT&T|T-?MOBILE/i,
    category: 'expense', subcategory: 'telephone_internet',
    why: 'Phone or internet service.',
  },

  // ── Insurance ──────────────────────────────────────────────────────────────
  {
    match: /HISCOX|INSURANCE/i,
    category: 'expense', subcategory: 'insurance',
    why: 'Business insurance premium.',
  },

  // ── People paid to do work ─────────────────────────────────────────────────
  {
    match: /FIVERR|UPWORK|PAYPAL \*|IN \*COLOR SERVICE/i,
    category: 'expense', subcategory: 'professional_services',
    why: 'Paid to an outside person or firm for work performed.',
  },

  // ── Equipment bought on installments ───────────────────────────────────────
  {
    match: /IPHONE CITIZ|BESTBUY|BEST BUY/i,
    category: 'expense', subcategory: 'equipment',
    why: 'Equipment purchase, including instalment plans.',
  },

  // ── Licences to practise ───────────────────────────────────────────────────
  {
    match: /IRS PTIN|PTIN FEE|LICENSE RENEWAL/i,
    category: 'expense', subcategory: 'licenses_permits',
    why: 'Professional licence required to prepare returns.',
  },

  // ── Client money arriving ─────────────────────────────────────────────────
  // 2025 income is measured from money actually received: the invoice ledger holds
  // nothing before 2026, and Relay, Mercury and Airwallex receipts were never
  // invoiced at all. The processor settlements below are the ONLY record of that
  // money, which is what makes them income rather than a transfer — unlike Airwallex
  // above, whose own account is in these books.
  {
    match: /ZOHO PAYMENTS|ORIG CO NAME:PAYONEER/i,
    category: 'income', subcategory: 'client_payment', direction: 'in',
    why: 'Client payment settled by the payment processor into the bank.',
  },
  {
    // Clients paying by international transfer, which arrives naming the sender and
    // often the invoice: "FROM: BNF-MC Digital Solutions LLC Via WISE REF: ...INV-00069".
    match: /REAL TIME TRANSFER RECD[\s\S]*BNF-/i,
    exclude: /BNF-\s*TONY DURANTE|BNF-\s*ANTONIO DURANTE/i,
    category: 'income', subcategory: 'client_payment', direction: 'in',
    why: 'Client paying by international transfer.',
  },
  {
    // An incoming Zelle from a named person or company is a client paying. The
    // exclusion is what keeps it honest: Antonio moving his OWN money in would
    // otherwise be booked as revenue.
    match: /ZELLE PAYMENT FROM/i,
    exclude: /TONY DURANTE|ANTONIO DURANTE|FIRSTCITIZEN|\bJODI\b/i,
    category: 'income', subcategory: 'client_payment', direction: 'in',
    why: 'Client paying by Zelle.',
  },

  // ── What the card itself charges ───────────────────────────────────────────
  {
    match: /PURCHASE INTEREST CHARGE|INTEREST CHARGE/i,
    category: 'fee', subcategory: 'interest',
    why: 'Interest charged by the card.',
  },
  {
    match: /FOREIGN TRANSACTION FEE|TRANSACTION FEE|ANNUAL MEMBERSHIP FEE|LATE FEE/i,
    category: 'fee', subcategory: 'bank_fee',
    why: 'Card fee.',
  },
]

/**
 * The one rule that is about a PERSON rather than a merchant.
 *
 * Personal spending on a company card is not a business expense — for an S-corp it
 * is money taken out, i.e. a distribution. Booking it as an expense would deduct it,
 * which is the direction that costs money if it is wrong. So anything matching here
 * defaults to a distribution and is listed for Antonio to pull back into expenses
 * where a charge really was business (a client dinner, a taxi to a meeting).
 *
 * Deliberately SEPARATE from the rules above so the list is easy to review and easy
 * to override — it is the only set where the classification depends on facts the
 * books cannot see.
 */
export const OWNER_PERSONAL_RULES: OwnerBooksRule[] = [
  {
    match: /SAGAZ MEN FASHION|HIDERGARDA|EXPENDEDURIA|ZETTLE_|COLORETAS|BODYHEALTH|EXPRESSABLE/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Personal purchase on the company card — defaults to a distribution unless Antonio confirms it was business.',
  },
  {
    match: /TAGLIATELLA|OUTBACK|LA ESQUINA|ARENAL 20|KIOSKO|VENDING LLC|RESTAURANT/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Meal — defaults to a distribution; a documented business meal can be moved to expenses.',
  },
  {
    // Vehicle, fuel and repairs. TD's work is done from a desk; a car charge on the
    // company card is personal unless Antonio says a trip was for a client.
    match: /BERT SMITH|SHELL OIL|BURT'S GAS|\bEXXON\b|\bCHEVRON\b|AUTOZONE|OLDSMOBILE|SETOYOTA|TOYOTA FIN/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Vehicle or fuel — defaults to a distribution unless it was a client trip.',
  },
  {
    // Groceries, pharmacy, clothing, personal care.
    match: /PUBLIX|WINN-?DIXIE|WALGREENS|\bCVS\b|BURLINGTON|PRIMO WATER|SP RA OPTICS|SP HIZOO|ENGINEEREDNUTRITION|DOC FORDS|WALMART|TARGET\b/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Household or personal retail purchase.',
  },
  {
    // Trips. Airfare, car hire, hotels and tolls are the charges most likely to be
    // genuinely business, so they default conservatively but are listed FIRST for
    // Antonio to reclaim — this is a fact about a trip, not an accounting judgment.
    match: /RYANAIR|CENTAURO|PRICELN|PRICELINE|EXPEDIA|BOOKING\.COM|AIRBNB|SINA ASTOR|RTN-TICKETING|CDT TRATTA|SINTRA|\bHOTEL\b|AIRLINES?\b/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Travel — defaults to a distribution; a business trip can be moved to expenses.',
  },
  {
    match: /TAXI LIC|PAY PARKING|LICENCIA \d/i,
    category: 'distribution', subcategory: 'owner_personal',
    why: 'Local transport — defaults to a distribution; business travel can be moved to expenses.',
  },
]

const ALL_RULES = [...OWNER_BOOKS_RULES, ...OWNER_PERSONAL_RULES]

/**
 * Categories that describe money LEAVING. A rule in one of these can only fire on
 * an outflow, whatever its pattern says.
 *
 * This is enforced here rather than written on each rule because forgetting it once
 * is enough to corrupt a year. IT ALREADY NEARLY DID: Chase checking receives client
 * money settled by "ZOHO PAYMENTS", and the ZOHO software-subscription pattern
 * matched those deposits — $25,321 of revenue was about to be booked as a negative
 * software expense, wrong on both the income and the expense line at once.
 */
const OUTFLOW_ONLY = new Set(['expense', 'cogs', 'fee', 'distribution'])

/**
 * Classify one transaction. Returns null when NO rule matches — deliberately, so an
 * unrecognised merchant stays `uncategorized` and visible instead of being swept
 * into a catch-all bucket where a real misclassification would never be noticed.
 */
export function classifyOwnerTransaction(
  description: string,
  amount: number,
  accountType?: string | null,
): OwnerBooksMatch | null {
  const text = description || ''
  for (const rule of ALL_RULES) {
    const direction = rule.direction || (OUTFLOW_ONLY.has(rule.category) ? 'out' : undefined)
    if (direction === 'in' && amount <= 0) continue
    if (direction === 'out' && amount >= 0) continue
    if (rule.accountTypes && !rule.accountTypes.includes(accountType || '')) continue
    if (rule.exclude && rule.exclude.test(text)) continue
    if (rule.match.test(text)) {
      return { category: rule.category, subcategory: rule.subcategory, why: rule.why }
    }
  }
  return null
}
