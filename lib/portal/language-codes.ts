/**
 * Real, bounded ISO 639-1 language codes — the validation boundary for
 * "any language, automatically" (dev job 12cab351). Closes the cost-abuse
 * gap the bug-hunter/AI-architect council pass flagged: without this, the
 * language API accepted any string, so a client could mint endless
 * never-before-seen codes ("xx1", "xx2", ...) to force a fresh, paid
 * translation batch each time. A real, closed list of ~180 known languages
 * still lets a client request one never offered before (the whole point),
 * but caps the total possible cost to a bounded, known set.
 */

export const LANGUAGE_NAMES: Record<string, string> = {
  aa: "Afar", ab: "Abkhazian", af: "Afrikaans", ak: "Akan", am: "Amharic",
  ar: "Arabic", an: "Aragonese", as: "Assamese", av: "Avaric", ae: "Avestan",
  ay: "Aymara", az: "Azerbaijani", ba: "Bashkir", bm: "Bambara", be: "Belarusian",
  bn: "Bengali", bi: "Bislama", bo: "Tibetan", bs: "Bosnian", br: "Breton",
  bg: "Bulgarian", ca: "Catalan", cs: "Czech", ch: "Chamorro", ce: "Chechen",
  cu: "Church Slavic", cv: "Chuvash", kw: "Cornish", co: "Corsican", cr: "Cree",
  cy: "Welsh", da: "Danish", de: "German", dv: "Divehi", dz: "Dzongkha",
  el: "Greek", en: "English", eo: "Esperanto", et: "Estonian", eu: "Basque",
  ee: "Ewe", fo: "Faroese", fa: "Persian", fj: "Fijian", fi: "Finnish",
  fr: "French", fy: "Western Frisian", ff: "Fulah", gd: "Gaelic", ga: "Irish",
  gl: "Galician", gv: "Manx", gn: "Guarani", gu: "Gujarati", ht: "Haitian",
  ha: "Hausa", he: "Hebrew", hz: "Herero", hi: "Hindi", ho: "Hiri Motu",
  hr: "Croatian", hu: "Hungarian", hy: "Armenian", ig: "Igbo", io: "Ido",
  ii: "Sichuan Yi", iu: "Inuktitut", ie: "Interlingue", ia: "Interlingua",
  id: "Indonesian", ik: "Inupiaq", is: "Icelandic", it: "Italian",
  jv: "Javanese", ja: "Japanese", kl: "Kalaallisut", kn: "Kannada",
  ks: "Kashmiri", ka: "Georgian", kr: "Kanuri", kk: "Kazakh", km: "Central Khmer",
  ki: "Kikuyu", rw: "Kinyarwanda", ky: "Kirghiz", kv: "Komi", kg: "Kongo",
  ko: "Korean", kj: "Kuanyama", ku: "Kurdish", lo: "Lao", la: "Latin",
  lv: "Latvian", li: "Limburgan", ln: "Lingala", lt: "Lithuanian", lb: "Luxembourgish",
  lu: "Luba-Katanga", lg: "Ganda", mh: "Marshallese", ml: "Malayalam", mr: "Marathi",
  mk: "Macedonian", mg: "Malagasy", mt: "Maltese", mn: "Mongolian", mi: "Maori",
  ms: "Malay", my: "Burmese", na: "Nauru", nv: "Navajo", nr: "South Ndebele",
  nd: "North Ndebele", ng: "Ndonga", ne: "Nepali", nl: "Dutch", nn: "Norwegian Nynorsk",
  nb: "Norwegian Bokmål", no: "Norwegian", ny: "Chichewa", oc: "Occitan",
  oj: "Ojibwa", or: "Oriya", om: "Oromo", os: "Ossetian", pa: "Punjabi",
  pi: "Pali", pl: "Polish", pt: "Portuguese", ps: "Pashto", qu: "Quechua",
  rm: "Romansh", ro: "Romanian", rn: "Rundi", ru: "Russian", sg: "Sango",
  sa: "Sanskrit", si: "Sinhala", sk: "Slovak", sl: "Slovenian", se: "Northern Sami",
  sm: "Samoan", sn: "Shona", sd: "Sindhi", so: "Somali", st: "Southern Sotho",
  es: "Spanish", sq: "Albanian", sc: "Sardinian", sr: "Serbian", ss: "Swati",
  su: "Sundanese", sw: "Swahili", sv: "Swedish", ty: "Tahitian", ta: "Tamil",
  tt: "Tatar", te: "Telugu", tg: "Tajik", tl: "Tagalog", th: "Thai",
  ti: "Tigrinya", to: "Tonga", tn: "Tswana", ts: "Tsonga", tk: "Turkmen",
  tr: "Turkish", tw: "Twi", ug: "Uighur", uk: "Ukrainian", ur: "Urdu",
  uz: "Uzbek", ve: "Venda", vi: "Vietnamese", vo: "Volapük", wa: "Walloon",
  wo: "Wolof", xh: "Xhosa", yi: "Yiddish", yo: "Yoruba", za: "Zhuang",
  zh: "Chinese", zu: "Zulu",
}

/** Case-insensitive check against the real ISO 639-1 set — the API boundary
 * for accepting a language a client requests. */
export function isValidLanguageCode(code: string): boolean {
  return typeof code === "string" && code.toLowerCase() in LANGUAGE_NAMES
}

export function languageName(code: string): string | undefined {
  return LANGUAGE_NAMES[code.toLowerCase()]
}
