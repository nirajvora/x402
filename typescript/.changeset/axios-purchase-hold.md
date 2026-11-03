---
"@x402/axios": minor
---

Hold one payment payload per Axios purchase and re-present it when the paid attempt fails ambiguously. Overlapping calls for the same method, caller URL, and stable body share one in-flight payload. A new payload is created only after `accepted.maxTimeoutSeconds` plus a 15 second grace and `reconcilePaymentPayload` returns `"unsettled"`. A settle `errorReason`, including a snake_case token with an empty `transaction`, does not release the hold. The table refuses a new purchase at 1000 entries instead of dropping a possible spend.

Responses release only their own hold generation. Structured purchase keys distinguish binary bytes from text without requiring a Node Buffer global.
