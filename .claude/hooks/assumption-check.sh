#!/bin/bash
# assumption-check.sh
# DEPRECATED (2026-05-26): This was a static reminder printed on every Stop
# regardless of what Claude actually wrote. Repeating the same advisory text
# every turn desensitized the model — it learned to skim and ignore it, which
# is exactly why R093 violations persisted (precedent: the Chiara Fazzini
# $30k/$35k conflict that shipped unflagged).
#
# Replaced by r093-verifier.sh, which launches an INDEPENDENT auditor model
# to diff the actual answer against the actual tool outputs and force a
# correction only when there is a real, evidence-backed violation. Friction is
# now applied precisely where a violation occurred, not as constant noise.
#
# Kept as a registered no-op so the settings.json hook entry stays valid.
exit 0
