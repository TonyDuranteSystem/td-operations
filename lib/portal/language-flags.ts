/**
 * Best-effort language → country flag for the language picker button
 * (dev job 12cab351, per Antonio's explicit request — the earlier UX
 * council pass this same session had dropped flags entirely; that was a
 * recommendation, not a requirement, and Antonio overrode it).
 *
 * Flags belong to countries (ISO 3166-1), not languages (ISO 639-1), so
 * this is a convention — the same one Google Translate and most language
 * pickers use — not a technical claim about where a language "belongs."
 * Multi-country languages (English, French, Spanish, Arabic, Portuguese,
 * Chinese...) get one common representative country by convention.
 *
 * Deliberately left unmapped (flagEmojiForLanguage returns null, caller
 * falls back to a neutral icon): constructed languages with no country at
 * all (Esperanto, Ido, Interlingua, Interlingue, Volapük), classical /
 * liturgical languages with no living state (Latin, Avestan, Church
 * Slavic, Pali, Sanskrit), and Yiddish (historically a stateless diaspora
 * language — Israel's national language is Hebrew, already mapped
 * separately, so reusing it for Yiddish would misrepresent both).
 */

const LANGUAGE_TO_COUNTRY: Record<string, string> = {
  aa: "ET", ab: "GE", af: "ZA", ak: "GH", am: "ET",
  ar: "SA", an: "ES", as: "IN", av: "RU",
  ay: "BO", az: "AZ", ba: "RU", bm: "ML", be: "BY",
  bn: "BD", bi: "VU", bo: "CN", bs: "BA", br: "FR",
  bg: "BG", ca: "ES", cs: "CZ", ch: "GU", ce: "RU",
  cv: "RU", kw: "GB", co: "FR", cr: "CA",
  cy: "GB", da: "DK", de: "DE", dv: "MV", dz: "BT",
  el: "GR", en: "GB", et: "EE", eu: "ES",
  ee: "GH", fo: "FO", fa: "IR", fj: "FJ", fi: "FI",
  fr: "FR", fy: "NL", ff: "SN", gd: "GB", ga: "IE",
  gl: "ES", gv: "IM", gn: "PY", gu: "IN", ht: "HT",
  ha: "NG", he: "IL", hz: "NA", hi: "IN", ho: "PG",
  hr: "HR", hu: "HU", hy: "AM", ig: "NG",
  ii: "CN", iu: "CA",
  id: "ID", ik: "US", is: "IS", it: "IT",
  jv: "ID", ja: "JP", kl: "GL", kn: "IN",
  ks: "IN", ka: "GE", kr: "NG", kk: "KZ", km: "KH",
  ki: "KE", rw: "RW", ky: "KG", kv: "RU", kg: "CD",
  ko: "KR", kj: "NA", ku: "IQ", lo: "LA",
  lv: "LV", li: "NL", ln: "CD", lt: "LT", lb: "LU",
  lu: "CD", lg: "UG", mh: "MH", ml: "IN", mr: "IN",
  mk: "MK", mg: "MG", mt: "MT", mn: "MN", mi: "NZ",
  ms: "MY", my: "MM", na: "NR", nv: "US", nr: "ZA",
  nd: "ZW", ng: "NA", ne: "NP", nl: "NL", nn: "NO",
  nb: "NO", no: "NO", ny: "MW", oc: "FR",
  oj: "CA", or: "IN", om: "ET", os: "GE", pa: "IN",
  pl: "PL", pt: "PT", ps: "AF", qu: "PE",
  rm: "CH", ro: "RO", rn: "BI", ru: "RU", sg: "CF",
  si: "LK", sk: "SK", sl: "SI", se: "NO",
  sm: "WS", sn: "ZW", sd: "PK", so: "SO", st: "LS",
  es: "ES", sq: "AL", sc: "IT", sr: "RS", ss: "SZ",
  su: "ID", sw: "TZ", sv: "SE", ty: "PF", ta: "IN",
  tt: "RU", te: "IN", tg: "TJ", tl: "PH", th: "TH",
  ti: "ER", to: "TO", tn: "BW", ts: "ZA", tk: "TM",
  tr: "TR", tw: "GH", ug: "CN", uk: "UA", ur: "PK",
  uz: "UZ", ve: "ZA", vi: "VN", wa: "BE", wo: "SN",
  xh: "ZA", yo: "NG", za: "CN", zh: "CN", zu: "ZA",
}

/** Converts a real ISO 3166-1 alpha-2 country code into its flag emoji via
 *  Unicode regional indicator symbols — no image asset, no icon library. */
function countryCodeToFlagEmoji(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map(char => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0)))
  return String.fromCodePoint(...codePoints)
}

/** Flag emoji for a language picker entry, or null when the language has
 *  no single associated country — callers fall back to a neutral icon. */
export function flagEmojiForLanguage(languageCode: string): string | null {
  const countryCode = LANGUAGE_TO_COUNTRY[languageCode.toLowerCase()]
  return countryCode ? countryCodeToFlagEmoji(countryCode) : null
}
