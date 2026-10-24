import { describe, it, expect } from "vitest"
import { DEFAULT_TEMPLATES, templateRows, templatesFor, unfillTemplate, unknownPlaceholder, type TeamTemplates } from "@/lib/marketing/templates"
import { applyTemplateEdit, isBuiltIn, newTemplateKey, MAX_TEMPLATES } from "@/lib/marketing/templates-edit"
import { parseSettingValue } from "@/lib/marketing/settings-schema"

describe("templates: what each language shows", () => {
  it("with nothing changed, the built-in templates in the language asked for", () => {
    const it = templatesFor("it")
    expect(it).toHaveLength(DEFAULT_TEMPLATES.length)
    expect(it[0].text).toBe(DEFAULT_TEMPLATES[0].text.it)
    expect(templatesFor("en")[0].text).toBe(DEFAULT_TEMPLATES[0].text.en)
  })
  it("the owner's wording wins field by field: a built-in with only an Italian edit keeps its English original", () => {
    const custom: TeamTemplates = { first_contact: { it: "Ciao {name}!" } }
    expect(templatesFor("it", {}, custom)[0].text).toBe("Ciao {name}!")
    expect(templatesFor("en", {}, custom)[0].text).toBe(DEFAULT_TEMPLATES[0].text.en)
  })
  it("the older single-text setting still applies to a built-in with no new entry, and the new entry beats it", () => {
    expect(templatesFor("it", { first_contact: "Vecchio" })[0].text).toBe("Vecchio")
    expect(templatesFor("it", { first_contact: "Vecchio" }, { first_contact: { it: "Nuovo" } })[0].text).toBe("Nuovo")
  })
  it("a template the owner created is listed after the built-in ones; one language only is shown to everyone in that language", () => {
    const custom: TeamTemplates = { t_abc: { label: "Offer", it: "Offerta per {name}" } }
    const en = templatesFor("en", {}, custom)
    expect(en[en.length - 1]).toEqual({ key: "t_abc", label: "Offer", text: "Offerta per {name}" })
  })
  it("the rows of the Templates screen carry both languages and where each comes from", () => {
    const rows = templateRows({}, { first_contact: { it: "Ciao" }, t_x: { label: "Mine", en: "Hi" } })
    const fc = rows.find(r => r.key === "first_contact")!
    expect(fc).toMatchObject({ builtIn: true, edited: true, it: "Ciao", en: DEFAULT_TEMPLATES[0].text.en })
    expect(rows.find(r => r.key === "no_answer")!.edited).toBe(false)
    expect(rows.find(r => r.key === "t_x")).toMatchObject({ builtIn: false, label: "Mine", it: "", en: "Hi" })
  })
})

describe("placeholders", () => {
  it("only {name} {setter} {when} are placeholders", () => {
    expect(unknownPlaceholder("Hi {name}, {setter} on {when}")).toBeNull()
    expect(unknownPlaceholder("Hi {nmae}")).toBe("nmae")
    expect(unknownPlaceholder("no braces")).toBeNull()
  })
  it("a message typed in the lead's box goes back to placeholders: this lead's name, this setter, this call time (whole words only)", () => {
    const v = { name: "Marco", setter: "Cristina", when: "Tue 27 Oct 11:00" }
    expect(unfillTemplate("Buongiorno Marco, sono Cristina. La chiamata: Tue 27 Oct 11:00. Marcos is not Marco.", v)).toBe("Buongiorno {name}, sono {setter}. La chiamata: {when}. Marcos is not {name}.")
    expect(unfillTemplate("Ciao Marco,", { name: "Marco" })).toBe("Ciao {name},")
    expect(unfillTemplate("Ciao Marcoli", { name: "Marco" })).toBe("Ciao Marcoli")
    expect(unfillTemplate("Ciao A", { name: "A" })).toBe("Ciao A")
    expect(unfillTemplate("Ciao Zoë", { name: "Zoë" })).toBe("Ciao {name}")
    expect(unfillTemplate("a.b", { name: "a.b" })).toBe("{name}")
  })
})

describe("changing templates (owner only; the route checks that)", () => {
  it("a new template needs a name and one text, gets its own key, and never changes the old set", () => {
    const cur: TeamTemplates = {}
    const r = applyTemplateEdit(cur, { action: "save", label: "Offer", it: "Ciao {name}" }, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(Object.keys(r.value)).toHaveLength(1); expect(r.key).toMatch(/^t_[a-z0-9]+$/); expect(r.value[r.key]).toEqual({ label: "Offer", it: "Ciao {name}" }) }
    expect(cur).toEqual({})
    expect(applyTemplateEdit({}, { action: "save", it: "x" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit({}, { action: "save", label: "x" })).toMatchObject({ ok: false, status: 400 })
  })
  it("an unknown placeholder is refused with the allowed ones named", () => {
    const r = applyTemplateEdit({}, { action: "save", label: "x", it: "Hi {nmae}" })
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (r.ok === false) expect(r.error).toContain("{name}")
  })
  it("editing a built-in merges field by field; a field sent empty goes back to the original; nothing left = no entry", () => {
    let r = applyTemplateEdit({}, { action: "save", key: "first_contact", it: "Ciao", en: "Hi" })
    expect(r.ok && r.value.first_contact).toEqual({ it: "Ciao", en: "Hi" })
    if (r.ok) r = applyTemplateEdit(r.value, { action: "save", key: "first_contact", en: "" })
    expect(r.ok && r.value.first_contact).toEqual({ it: "Ciao" })
    if (r.ok) r = applyTemplateEdit(r.value, { action: "save", key: "first_contact", it: "" })
    expect(r.ok && "first_contact" in r.value).toBe(false)
  })
  it("saving into the Italian text only leaves the English alone (the lead box saves in the page's language)", () => {
    const cur: TeamTemplates = { t_a: { label: "A", it: "uno", en: "one" } }
    const r = applyTemplateEdit(cur, { action: "save", key: "t_a", it: "due" })
    expect(r.ok && r.value.t_a).toEqual({ label: "A", it: "due", en: "one" })
  })
  it("a template of the owner's must keep a name and one text; a key that does not exist is a 404", () => {
    const cur: TeamTemplates = { t_a: { label: "A", it: "uno" } }
    expect(applyTemplateEdit(cur, { action: "save", key: "t_a", it: "" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit(cur, { action: "save", key: "t_a", label: "" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit(cur, { action: "save", key: "t_gone", it: "x" })).toMatchObject({ ok: false, status: 404 })
  })
  it("reset only for a built-in; delete only for the owner's own; a built-in can never be deleted", () => {
    expect(applyTemplateEdit({ first_contact: { it: "x" } }, { action: "reset", key: "first_contact" })).toMatchObject({ ok: true, value: {} })
    expect(applyTemplateEdit({ t_a: { label: "A", it: "x" } }, { action: "reset", key: "t_a" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit({ t_a: { label: "A", it: "x" } }, { action: "delete", key: "t_a" })).toMatchObject({ ok: true, value: {} })
    expect(applyTemplateEdit({}, { action: "delete", key: "first_contact" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit({}, { action: "delete", key: "t_gone" })).toMatchObject({ ok: false, status: 404 })
  })
  it("there is a limit on how many the owner can create, and keys never collide with a built-in or each other", () => {
    const many: TeamTemplates = {}
    for (let i = 0; i < MAX_TEMPLATES; i++) many[`t_${i}`] = { label: "x", it: "y" }
    expect(applyTemplateEdit(many, { action: "save", label: "one more", it: "z" })).toMatchObject({ ok: false, status: 400 })
    const k1 = newTemplateKey({ t_1: { label: "x" } }, 1)
    expect(k1).not.toBe("t_1")
    expect(isBuiltIn("first_contact")).toBe(true)
    expect(isBuiltIn(k1)).toBe(false)
  })
})

describe("the team_templates setting", () => {
  it("accepts the shape, refuses a bad key, and starts empty", () => {
    expect(parseSettingValue("team_templates", {})).toMatchObject({ ok: true })
    expect(parseSettingValue("team_templates", { t_a: { label: "A", it: "x", en: "y" } })).toMatchObject({ ok: true })
    expect(parseSettingValue("team_templates", { "Bad Key!": { it: "x" } })).toMatchObject({ ok: false })
    expect(parseSettingValue("team_templates", { t_a: { it: 5 } })).toMatchObject({ ok: false })
  })
})

describe("bug-hunt fixes (PR 825)", () => {
  it("a name that is part of the template's own wording stays wording (the owner is called Rocco and the built-in says 'Tony Durante and Rocco')", () => {
    const original = DEFAULT_TEMPLATES[0].text.en
    const filled = original.replace(/\{name\}/g, "Marco").replace(/\{setter\}/g, "Rocco")
    const back = unfillTemplate(filled, { name: "Marco", setter: "Rocco" }, original)
    expect(back).toContain("Tony Durante and Rocco")
    expect(back).toContain("Hello {name}")
    // without the original the fixed wording would have been turned into a placeholder
    expect(unfillTemplate(filled, { name: "Marco", setter: "Rocco" })).toContain("Tony Durante and {setter}")
  })
  it("when the lead and the setter share a name nothing is guessed", () => {
    expect(unfillTemplate("Buongiorno Cristina, sono Cristina", { name: "Cristina", setter: "Cristina" })).toBe("Buongiorno Cristina, sono Cristina")
    expect(unfillTemplate("Ciao Cristina, il {when}", { name: "Cristina", setter: "Cristina", when: "il {when}" })).toContain("Ciao Cristina")
  })
  it("a doubled brace is not a placeholder", () => {
    expect(unknownPlaceholder("Hi {{name}}")).not.toBeNull()
    expect(unknownPlaceholder("Hi {name}")).toBeNull()
    expect(applyTemplateEdit({}, { action: "save", label: "x", it: "Hi {{name}}" })).toMatchObject({ ok: false, status: 400 })
  })
  it("the Templates screen shows the built-in names in the page's language", () => {
    expect(templateRows({}, {}, "it")[0].label).toBe(DEFAULT_TEMPLATES[0].label.it)
    expect(templateRows({}, {}, "en")[0].label).toBe(DEFAULT_TEMPLATES[0].label.en)
    expect(templateRows()[0].label).toBe(DEFAULT_TEMPLATES[0].label.en)
  })
  it("two templates created in the same millisecond get different keys", () => {
    let n = 0
    const rand = () => (n++ % 2 === 0 ? 0.1 : 0.9)
    const a = newTemplateKey({}, 1000, rand)
    const b = newTemplateKey({}, 1000, rand)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^t_[a-z0-9]+$/)
  })
  it("the limit also applies to a built-in that gets its first entry (the setting would refuse it with a vague error)", () => {
    const many: TeamTemplates = {}
    for (let i = 0; i < MAX_TEMPLATES; i++) many[`t_${i}`] = { label: "x", it: "y" }
    expect(applyTemplateEdit(many, { action: "save", key: "first_contact", it: "Ciao" })).toMatchObject({ ok: false, status: 400 })
    expect(applyTemplateEdit({ first_contact: { it: "a" } }, { action: "save", key: "first_contact", it: "b" }).ok).toBe(true)
  })
})

