# Handwritten transcription: bounded concurrency

## Scope

This change applies to Answer Studio on `fix/math-rendering-consistency`.
It does not change the model ID, API key, image resolution, math formatting,
Word content modes, or the transcription-warning checkbox. No dependencies,
server database migrations, deployments, or merges into `main` are required.

## Controls and scheduling

The material-input section keeps this control in the collapsed **高级** section,
labelled **同时处理的页数**. The default is **4 pages**; users can choose
**1, 2, 4, or 6**. Its note explains that more pages can be faster but can also
trigger provider rate limits. The stored numeric setting and scheduling remain
unchanged. This is a maximum for
one running browser task, not a promise that the provider can support that
throughput. It does not combine quotas or limit other users/tabs globally.

The first pending page of each role is processed alone when no page of that
role has been completed. It establishes initial lesson/section context. Then
small windows run concurrently. All original-question pages finish before the
answer-page phase. Within each role, source input order is retained, including
file order; results are never ordered by response arrival or by lexicographic
question numbers.

For the full output mode, drawing jobs use at most **2 concurrent questions**.
The existing initial drawing and visual-QA calls for a single question remain
sequential. Text-only and steps-only modes still make no drawing calls.

Changing the speed setting does not clear the current draft or re-recognize
completed pages. The selection is component state; a page reload restores the
default. Controls are disabled while a run is active.

## Cross-page continuity

A parallel window shares the context committed BEFORE that window. This is not
equivalent to having every immediate predecessor available at recognition time.
The route explicitly tells the model not to guess missing ownership from an
unrelated earlier question.

Before ordered merge, a page with a continuation, an ownership warning, missing
section/number, or a conflicting existing key is re-recognized serially when the
context has advanced. That review uses the latest committed predecessor context.
It must succeed before the page is marked processed. No mathematical steps are
invented or repaired by the scheduler.

This protects detected ambiguity; it cannot guarantee detection of every model
misclassification. For documents dominated by continuous multi-page derivations,
use **1 lane** as the conservative baseline and compare the output with the source.
Extra boundary reviews can reduce the speedup and add model requests.

## Retries and provider status

- Only temporary network failures and HTTP 408, 429, 500, 502, 503, 504 are retried.
- At most **two additional attempts** per failed task.
- Exponential backoff starts at 1 second, then 2 seconds, with random jitter.
- `Retry-After` is retained through the Gemini/OpenAI-compatible adapter, Studio
  route, and browser client. Seconds and HTTP-date forms are supported.
- 429/503 reduce the active window limit, e.g. 4 -> 2 -> 1. This reduced setting
  lasts for the current stage; there is no automatic upward probing in this version.
- A `Retry-After` longer than 60 seconds stops automatic retries rather than
  retrying before the provider allows it. Resume later after the quota recovers.
- Invalid keys, authorization failures, malformed output and missing local API
  configuration are not treated as temporary errors.
- Studio auto mode does not immediately switch API protocols on a rate-limit,
  authentication, or transient server error; the scheduler owns that backoff.

Drawing retries restart the question's drawing job, including its existing
visual-QA flow. This may repeat a successful first call when a later QA call
failed. There is no unbounded retry or extra speculative model call.

Reference: Gemini API troubleshooting and HTTP `Retry-After` semantics:
https://ai.google.dev/gemini-api/docs/troubleshooting
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After

## Checkpoints and failure isolation

Concurrent workers only return results (drawing workers use private question
copies). A single coordinator merges and writes snapshots in source order.
It waits for all launched requests in the current window to settle before
returning an error: no late worker can overwrite the resumed task's state.

Every successful page in a settled window is first stored in optional local
`pendingTranscriptions` metadata, keyed by page ID and source hash. Then pages
are merged and marked processed one by one. If an earlier page fails, later
successful results remain cached, not silently discarded or merged ahead of it.
Resume requests only missing pages, plus any required fresh-context review.

The metadata uses the existing browser IndexedDB draft storage. Old drafts
without it remain supported. It contains results/context only, not duplicate
images or API credentials. A crash before the current window settles may still
require repeating that window's unfinished/uncheckpointed work.

Drawing failures keep the text and evidence and remain eligible for regeneration.
Completed drawings are reused. Persistent throttling/authentication failure stops
new drawing windows while preserving successful peers; users can still choose a
text-only output. Regenerating an already matched paired draft does not append
its answer tables a second time.

## Validation

Run the focused suite without building the website:

```bash
node --test tests/answer-studio-concurrency.test.mjs
```

The suite executes the actual TypeScript scheduling/pipeline/route modules.
It mocks provider responses, storage and image preparation; it makes no paid
Gemini calls. It checks concurrency limits, reverse completion order, sequential
checkpoints, phased matching, continuation review, resume caches, source-hash
invalidation, retry caps/backoff, status propagation, drawing failure isolation,
and retention of the existing Word UI controls.

Implementation-environment result: **28 focused tests passed**. Strict TypeScript
checking of the scheduling/pipeline modules and their pure dependencies passed;
modified TS/TSX syntax checks also passed.

Not verified here: full application build/lint/regression suite, real-browser UI
interaction, live Gemini/proxy throughput, and generated Word visual output.
The execution environment cannot resolve GitHub/npm hosts for a full dependency
installation. Keep this change in the existing draft PR until local acceptance.

## Local acceptance

1. Pull this branch without overwriting uncommitted work; retain `.env.local`.
2. Restart `npm run dev` and use a small representative document with 1 lane.
3. Repeat with 4 lanes. Check total time, page/question counts, ordering, LaTeX,
   tables, and especially continuations across a window boundary.
4. Exercise a failed-page resume and confirm successful later pages are reused.
5. Generate a full version to check two-lane drawings, then each text-only mode.
   The green button stays `生成 Word`; the warning checkbox remains independent.
6. Do not infer a fixed 4x speedup from the setting: provider RPM/TPM/concurrency,
   slow pages, boundary reviews and retries all affect real elapsed time.
