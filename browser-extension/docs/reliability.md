# Orbit 0.2 reliability report

The target is dependable end-to-end browser tasks. **98% accuracy across arbitrary websites has not been demonstrated.** A small model, a tool engine, and an application integration need separate evaluations.

## Current evidence

| Check | Result | What it establishes |
| --- | --- | --- |
| Core tests | 22 / 22 passed | Schema, model streaming, cancellation, replay guards, completion criteria, recovery model, context limits |
| Engine scenarios | 32 / 32 passed | Real Chromium DOM driven through a test adapter with deterministic decisions |
| UI integration | 6 / 6 passed | Full side-panel flow with fixture Ollama responses and an explicit Chrome API adapter |
| Live Qwen3.5 0.8B task benchmark | Blocked; 0 tasks executed | Model weights are not installed; no model accuracy score is available |
| Native Chrome extension installation | Unverified in this cloud | Managed Chromium blocks unpacked extension installation |

The engine suite includes both positive workflows and expected rejections. Its pass rate is **not** end-to-end task accuracy. It uses local fixtures, not a representative sample of live websites. The raw engine report is [engine-benchmark.json](engine-benchmark.json); any sample interval in that file applies only to its scenario pass proportion, not global browser or model accuracy.

## Engine coverage

| Category | Passed / total |
| --- | --- |
| Agent | 3 / 3 |
| Controls | 9 / 9 |
| Recovery | 4 / 4 |
| Research | 4 / 4 |
| Safety | 7 / 7 |
| Verification | 5 / 5 |

Scenarios include accessible labels, Unicode text, dropdowns, disabled/read-only controls, delayed field rejection, retained values after framework-style rerenders, unique target recovery, ambiguous target rejection, changed form destinations, overlays, open shadow roots, same-origin frames, nested scrolling, delayed results, unverified no-op clicks, guarded Enter, Tab focus, structured extraction, hidden/field value exclusion, failed assertions, premature completion rejection, and prevention of repeated uncertain purchases. Purchases and submissions are local fixtures only.

## What changed

- Semantic target identities include label, role, input type, scope, destination, and form metadata. Framework replacements recover only when exactly one current control matches.
- Fields are read back across a short stability window. Clicks wait for navigation or rendered state changes. Unobserved effects remain unverified.
- The action loop records browser receipts and refuses to replay a consequential action that was already dispatched.
- Optional user-defined literal page-text criteria must pass independently before a task receives a verified completion status. Missing or incomplete verification results cannot be treated as success.
- Typed values, editable drafts, and password/code/payment fields are excluded from page text and labels where appropriate. Passwords, codes, payment credentials, and uploads stay manual.
- The small-model prompt is bounded, page controls are task ranked, malformed actions receive one repair attempt, and a configured local recovery model can take over after failures.
- New actions provide rendered tables/links/headings, limited keyboard controls, waiting for expected text, and explicit assertions.

## Run the live evaluation

```sh
cd browser-extension
ollama pull qwen3.5:0.8b
ORBIT_MODEL=qwen3.5:0.8b npm run benchmark:live
```

The live runner uses the actual configured local model for eight research/form tasks. It checks both DOM state and answers against fixture-specific assertions. It fails rather than substituting scripted decisions when the model is missing. Task traces and a result report go in `test-results/`. Expand this into held-out, representative live-site workflows before making a 98% claim. These eight synthetic tasks alone cannot substantiate that claim.

## Remaining limits

A confirmed click receipt establishes that an observable change occurred; unrelated page updates can also change the DOM. It does not prove transaction success. Field readback has a bounded observation window. Literal completion checks can match unrelated wording and should use specific success phrases. Website code can have effects that cannot be inferred from a button label.

Cross-origin frames, closed shadow roots, native widgets requiring trusted input, canvas/visual-only interfaces, and CAPTCHAs remain unsupported. The engine never bypasses managed browser policy.

In this cloud, command-line HTTPS can read the Ollama registry metadata, but model blobs redirect to a denied storage hostname. The running Ollama pull also encountered DNS errors. Required blob access was saved in the environment draft for:

`dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com`

Review and save the draft in environment settings, retry the affected model installation and live evaluation, then publish the environment after validation. Saving the draft alone does not apply its changes, install a model, publish a snapshot, or establish live-model accuracy.
