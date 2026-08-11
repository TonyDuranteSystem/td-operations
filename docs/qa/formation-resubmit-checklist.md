# Formation re-submit — click-through checklist (sandbox)

Dev job `ca788354`. **Sandbox only. Nothing here touches production.**

Six QA clients are already set up in sandbox. Their names tell you which case they are.
Every one of them is a fixture — none mirrors a real client.

| QA client | What they are | Where they should be |
|---|---|---|
| QA Resubmit **One** | Company already formed and finished (EIN received) | wizard should be **locked** |
| QA Resubmit **Two** | Company already exists, wizard re-opened with nothing identifying it | wizard stays **open** — he is protected at submit, not on the page |
| QA Resubmit **Three** | Formed one company, now forming a **second** | second wizard should be **open** |
| QA Resubmit **Four** | Formation in progress, just submitted | wizard should be **open** |
| QA Resubmit **Five** | Formation in progress, setup never finished | wizard should be **open** |
| QA Resubmit **Six** | Brand-new, nothing yet | wizard should be **open** |

**Signing in.** Sandbox portal, one login per client:
`qa-resubmit-one@tdsandbox.test` … `qa-resubmit-six@tdsandbox.test`,
all with the same password: `QAresubmit-2026!`

These exist only in sandbox and only for this test.

---

## What you are checking

**1. The lock behaves like tax.**
Open each client's formation wizard.

- **One** must be read-only, saying his details are with us and offering a chat button.
- **Two, Three, Four, Five, Six** must still be editable. Two looks open on purpose:
  his wizard was never submitted, so there is nothing to lock — the protection for
  him happens when he submits, not before.

The one that matters most is **Three**: he has a finished company *and* a new one.
His new wizard must still be editable. If it's locked, the fix is keyed wrong and
every repeat client is blocked — stop and tell me.

**2. A finished client's re-submit changes nothing.**
For **One**, force a submit (re-open and submit again).

Afterwards, nothing new should appear anywhere:
- no second company formation in his services
- his existing formation must not have moved stage
- **no new notification in his portal** — this is the one clients actually saw
- his form record must still say it was completed and reviewed **on 1 June**, not today

His contact details *should* update if you changed anything — that's deliberate.
Support should also receive an email saying a finished formation was re-submitted,
listing what changed. **Sandbox blocks outgoing email**, so that one can't be checked
by inbox — it shows in the job's own record instead.

**3. Nobody gets a WhatsApp task.**
Any of the six. There should be no "WhatsApp follow-up" task created for anyone,
ever again — the step is gone, not just switched off.

**4. Two fast clicks make one of everything.**
For **Four**, submit twice within a few seconds. One notification, one delivery.

---

## What "wrong" looks like

Stop and tell me if you see any of these:

- a second **Company Formation** appearing for One, Two or Three
- Three's new company wizard locked
- any client getting a second "Formation data received!" notification
- One's form record showing today's date instead of 1 June
- a "WhatsApp follow-up" task anywhere
- a client seeing an error or a "technical issue" message — they should see nothing unusual at all

---

## Cleaning up

The six QA clients can be deleted afterwards; they're marked with the
`qa-resubmit-…@tdsandbox.test` email pattern and exist only in sandbox.
