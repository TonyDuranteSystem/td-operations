import { describe, it, expect } from "vitest"
import {
  WAITING_ON_VALUES,
  WAITING_ON_LABELS,
  documentMissingMessage,
  documentStepsCrossed,
  isWaitingOn,
  onlyChangedStepSettings,
  stageNotificationText,
  stepSettingsProblems,
} from "@/lib/services/step-settings"

describe("isWaitingOn", () => {
  it("accepts every allowed value", () => {
    for (const v of WAITING_ON_VALUES) expect(isWaitingOn(v)).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isWaitingOn("Client")).toBe(false)
    expect(isWaitingOn("")).toBe(false)
    expect(isWaitingOn(null)).toBe(false)
    expect(isWaitingOn(undefined)).toBe(false)
    expect(isWaitingOn(3)).toBe(false)
  })
  it("has a label for every value", () => {
    for (const v of WAITING_ON_VALUES) expect(WAITING_ON_LABELS[v]).toBeTruthy()
  })
})

describe("stepSettingsProblems", () => {
  it("is empty for a normal list", () => {
    expect(
      stepSettingsProblems("CMRA Mailing Address", [
        { stage_name: "Lease Created", waiting_on: "client" },
        { stage_name: "CMRA Active", waiting_on: "none", completes_service: true },
      ]),
    ).toEqual([])
  })

  it("is empty with no done step and no settings", () => {
    expect(stepSettingsProblems("Company Formation", [{ stage_name: "Data Collection" }])).toEqual([])
  })

  it("refuses two done steps, naming both", () => {
    const p = stepSettingsProblems("DBA", [
      { stage_name: "Registered", completes_service: true },
      { stage_name: "Renewal Due", completes_service: true },
    ])
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('"Registered"')
    expect(p[0]).toContain('"Renewal Due"')
  })

  it("refuses an action-required step not waiting on the client", () => {
    const p = stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "us" }])
    expect(p).toHaveLength(1)
    expect(p[0]).toContain("Client Signing")
  })

  it("accepts an action-required step waiting on the client, or not set", () => {
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "client" }])).toEqual([])
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: null }])).toEqual([])
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing" }])).toEqual([])
  })

  it("does not apply the registry rule to a same-named step of another service", () => {
    expect(stepSettingsProblems("EIN", [{ stage_name: "Client Signing", waiting_on: "us" }])).toEqual([])
  })
})

describe("stageNotificationText", () => {
  it("uses the done step's own client label when it has one", () => {
    expect(
      stageNotificationText({
        serviceName: "CMRA 2027", isCompleted: true, stageLabel: "Your office address is active", hasClientLabel: true,
      }),
    ).toEqual({ title: "CMRA 2027 — Your office address is active", body: "Your office address is active" })
  })
  it("keeps the generic wording for a done step without a client label", () => {
    expect(
      stageNotificationText({ serviceName: "EIN", isCompleted: true, stageLabel: "EIN Received", hasClientLabel: false }),
    ).toEqual({ title: "EIN is complete!", body: "Your service has been completed." })
  })
  it("an ordinary move says the step it moved to", () => {
    expect(
      stageNotificationText({ serviceName: "EIN", isCompleted: false, stageLabel: "Sign your SS-4", hasClientLabel: true }),
    ).toEqual({ title: "EIN update", body: "Status updated to: Sign your SS-4" })
  })
})

describe("documentStepsCrossed — same range as the database rule", () => {
  const steps = [
    { stage_name: "Name Check", stage_order: 2 },
    { stage_name: "Money Order", stage_order: 5, requires_document_to_advance: true },
    { stage_name: "Mailed to State", stage_order: 6 },
    { stage_name: "Registered", stage_order: 7 },
  ]
  it("leaving the step needs its document", () => {
    expect(documentStepsCrossed(steps, 5, 6)).toEqual(["Money Order"])
  })
  it("jumping over the step needs its document", () => {
    expect(documentStepsCrossed(steps, 2, 7)).toEqual(["Money Order"])
  })
  it("moving ONTO the step needs nothing yet", () => {
    expect(documentStepsCrossed(steps, 2, 5)).toEqual([])
  })
  it("going back, staying, or an unknown step needs nothing", () => {
    expect(documentStepsCrossed(steps, 7, 2)).toEqual([])
    expect(documentStepsCrossed(steps, 5, 5)).toEqual([])
    expect(documentStepsCrossed(steps, undefined, 7)).toEqual([])
  })
  it("the message names the step", () => {
    expect(documentMissingMessage(["Money Order"])).toBe(
      'A document must be uploaded on "Money Order" before this job can move on.',
    )
  })
})

describe("onlyChangedStepSettings — a screen left open can't undo someone else's change", () => {
  const loaded = { waiting_on: "us", completes_service: true, requires_document_to_advance: false, client_label: "Old", client_label_it: null }
  it("drops every setting the person did not touch", () => {
    const out = onlyChangedStepSettings({ stage_name: "X", ...loaded }, loaded)
    expect(out).toEqual({ stage_name: "X" })
  })
  it("keeps the ones they changed", () => {
    const out = onlyChangedStepSettings({ stage_name: "X", ...loaded, completes_service: false, client_label: "New" }, loaded)
    expect(out).toEqual({ stage_name: "X", completes_service: false, client_label: "New" })
  })
  it("treats blank vs unset text and false vs unset flags as no change", () => {
    const out = onlyChangedStepSettings(
      { stage_name: "X", ...loaded, client_label_it: "  ", requires_document_to_advance: null },
      loaded,
    )
    expect(out).toEqual({ stage_name: "X" })
  })
  it("a step added on this screen sends everything", () => {
    const fresh = { stage_name: "New step", waiting_on: "client" }
    expect(onlyChangedStepSettings(fresh, undefined)).toEqual(fresh)
  })
})
