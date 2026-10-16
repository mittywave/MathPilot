# Handwritten transcription: bounded concurrency

## Scope

This change applies to Answer Studio on `fix/math-rendering-consistency`.
It does not change the model ID, API key, image resolution, math formatting,
Word content modes, or the transcription-warning checkbox. No dependencies,
server database migrations, deployments, or merges into `main` are required.

## Controls and scheduling

The original-question and answer entries sit side by side in the right
workspace; there is no mode switch. The entries decide the mode
(`studioInputMode`): originals only become an editable question paper, answers
only are transcribed alone, and both are paired. The page shows the mode above
Start, and the server reads it from the uploaded page roles when the job starts.
Both entries support file selection, dropping, and page-level image/PDF paste.
Clicking the file picker replaces that entry's files; paste and drop append.
With no recent entry interaction, paste fills the first empty visible entry
(originals first), then the answer entry. A recently clicked or dropped entry takes priority while visible.
Closed, occluded, off-screen and busy entries do not receive pasted files; plain
text paste remains unchanged. A populated entry collapses to one row.

Intake retains the original File objects. It does not use HomeworkPagePicker
or pre-render PDF pages: the existing Studio reader, page ordering and request
pipeline process them after Start. Unsupported files do not erase accepted
materials.

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
completed pages. The selection is stored on the server job when it is created;
a page reload restores the default for the next job.

## Background jobs

Text transcription runs on the server so the teacher can leave the page:

1. The page renders PDF/image pages (PDF.js, canvas) and uploads them one at a
   time, in source order, to `POST /api/answer-studio/jobs/<id>/pages`: the
   full page (for figure crops) and the 2200 px recognition copy. Leaving the
   page before the upload finishes leaves an unfinished job that can only be
   deleted.
2. Starting the job sends a `studio_transcription` message on the existing
   homework queue. The consumer runs the same `transcribeStudio` text phase;
   checkpoints write the draft to R2 (`studio/<id>/draft.json`) and progress to
   the `studio_jobs` row. The local queue (miniflare) delivers one batch at a
   time, so each delivery works for about 2 minutes, then re-queues itself and
   resumes from the checkpoint: homework grading waits at most one slice. The
   claiming worker stores a `run_id`; its updates apply only while it still
   owns the job, so a duplicate message or a continued job never runs twice.
3. A failed job keeps its processed pages; **继续** re-queues it. A queued or
   running job with no update for 5 minutes has lost its worker (a server
   restart drops queued messages) and shows **已中断** with 继续 and 删除.
4. **打开** on a finished job downloads the draft and the full page images back
   into the page. Figures and Word are still built in the browser, because the
   drawing pass composites and rasterizes images on a canvas.
5. Queued and running rows have a **取消转录** button at the far right. It
   stops the job without deleting originals or saved pages; the row shows
   **已取消** and retains **继续** and **删除**. Cancellation reuses the existing
   resumable `failed` state with empty `error` and `progress = '已取消'`, so no
   schema change is needed. It revokes the worker's `run_id`; queued deliveries
   cannot claim it, and every recognition attempt and checkpoint checks
   ownership. An active worker checks ownership once per second and aborts its
   provider requests when revoked. Requests already sent may still have been
   processed by the provider. Cancelling a job that has just finished preserves
   its completed result.

Jobs, page images and drafts stay on the server until the teacher deletes the
job. The task list polls every 3 seconds only while a job is queued or running.

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
  drawing route, browser client and the server job. Seconds and HTTP-date forms are supported.
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

The metadata is part of the job draft stored in R2. It contains results/context only, not duplicate
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
