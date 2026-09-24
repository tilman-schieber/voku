# Working on voku

Read `README.md` first for what the app is. This file is for the things that
are not derivable from the code — decisions that were argued out, and the
reasoning behind them, so they do not get quietly undone.

## Who you are working with

A teacher, not a programmer. He knows the subject, the classroom and what this
app is for better than anyone. He does not know git, the terminal, or what a
container is, and does not need to.

- **You drive the tools.** Run the app, the tests, git and the browser yourself
  rather than printing commands for him to run. "I've pushed it, it'll be live in
  two minutes" is useful; "now run `git push`" is a dead end.
- **Explain in the vocabulary of the app, not the codebase.** "The review screen
  will show the missed words first" lands. "I changed the sort in `Review.tsx`"
  does not. Name a file only when he will need to find it again.
- **The decisions below are a conversation, not a veto.** When he asks for
  something that would reverse one, say what it costs in terms he can weigh —
  "multiple choice on easy words means they can guess their way to a good score"
  — and then do what he decides. He owns this app now.
- **Do not leave him at a half-finished step.** A developer can take over from
  "just needs the migration wired up". He cannot. Finish it, or say plainly that
  it is not finished and what is missing.

## Your machine is staging

There is no staging server. The app running on this machine *is* it, and pushing
to `main` deploys to the live site by itself — so a push is a decision, not a
save.

That splits the checking in two, and both halves are needed:

- **"Does this look right?"** Only eyes answer that, on the actual screen, in a
  browser. This project has a history of bugs that survived careful reasoning
  about the UI and died the moment someone opened it — a heading that scrolled
  instead of wrapping, progress shown off screen, text below the contrast floor.
  Offer to run the app and say which screen to look at; do not report a visual
  change as done on the strength of the diff.
- **"Did I break something I wasn't looking at?"** `npm test` answers that. Run
  it before pushing rather than leaving it to CI, which runs it again and blocks
  the deploy on failure — the point is to know in ten seconds.

A failed deploy rolls itself back and the database is backed up before every one,
so the cost of being wrong is an unshipped change, not a broken lesson.

**Starting it on Windows.** Run the two processes separately:

```
npm run dev --workspace=@voku/server    # the API, on port 3000
npm run dev --workspace=@voku/web       # the app, on port 5173 — open this one
```

Not the bare `npm run dev` from the project root. It joins the two commands with
`&`, which Windows reads as "one after the other" rather than "both at once", so
the second never starts and `localhost:5173` looks dead for no visible reason.

Setup, fetching a copy of the live data, and the rollback procedure are in
`Working on voku.md`. Deployment mechanics are `deploy/deploy.sh` and
`.github/workflows/deploy.yml`.

## The one idea everything hangs off

The score is `correct ÷ target` and it is **uncapped**. Reaching the target is
100%; 38 correct against a target of 25 is 152%, and chasing that is the point.
The question pool is deliberately larger than the target so strong students have
runway. Anything that caps, normalises or "fixes" the percentage breaks the
format — check before changing it.

## Decisions that were made deliberately

Do not reverse these without asking. Each was chosen over a named alternative.

| Decision | Why, and what it cost |
|---|---|
| **Strict spelling.** `recieve` is wrong. | Spelling is what German learners get wrong. Made liveable by the bulk-regrade panel, which is therefore load-bearing, not a nicety. |
| **No question shuffling.** Identical order for the whole class. | Makes position 12 comparable across students. Copying is possible; the clock does the policing. |
| **Multiple choice only for traps or hard words** — trickiness ≥ 2, or difficulty in the top 40% of *this test* (floor 4). | Wrong answers cost nothing, so MCQ on an easy word is free marks. The threshold is relative because models calibrate differently; a fixed cutoff silently emptied both MCQ formats when one scored conservatively. |
| **Format mix is preferences, not quotas.** | A text with three tricky words cannot support ten MCQs. The composer reports the shortfall instead of inventing traps. |
| **No behavioural telemetry.** Nothing records app-switching. | Monitoring minors, false-positives on notifications. The only personal data is a first name and a score. |
| **Revising before a test drills the word pairs, never the test's own questions.** | The questions are identical for everyone and in a fixed order, so practising them would measure rehearsal, and familiar options kill the MCQ traps. Costs: the drill cannot reuse the composed pool, and nothing about it is stored, so there is no "who revised" to report. |
| **Spacing is scheduled for the class, and only ever suggested.** | Per-student scheduling is the better-evidenced version and was rejected anyway: it needs months of per-child history, which contradicts storing only a first name and a score. Words are offered on a widening schedule (~10 / 28 / 70 days, halved when the class struggled, doubled when they knew it); the teacher ticks what comes back, so a unit needing all-new vocabulary can have it. |
| **A student's "words to work on" are theirs alone.** Their own graded misses from closed tests, reached questions only; a word leaves the list once got right in a later test. | Nothing new is collected — the answers were already kept for review and regrade — and it is never shown to the teacher, who sees per-word class results and needs no per-child list of failures. Practice does not clear it, because practice is not stored; the test is where a word is shown to be known, which is what the spacing suggestions feed. |
| **A returning word is named, not coloured** — "from Unit 3". | The accent already means "your answer was right" to a student, a second accent would break a brief that rations one, and colour does not survive a photocopier. The label also carries more: which unit, not just that it is old. |
| **While any test in the class runs, nothing that shows an answer is served** — no study list, drill, own words, earlier review or practice run. | Spacing makes overlap deliberate: a word brought back from an earlier unit is also a question in the running test, so an earlier list is the answer one tab away. Holds for early finishers too. Cost: nobody revises during those minutes. Enforced on the server; the home screen only hides the doors. |
| **Handing in shows the score; the review opens when the test closes.** | It used to open on handing in, which put the whole answer key — unreached questions included — in an early finisher's hands while the room was still writing. Cost: fast students wait a few minutes for their answers. The instant feedback after each question is a separate decision and unchanged, so a student who reaches every question has still seen every answer once. |
| **The live board is private to the teacher.** | A leaderboard would publicly identify the same struggling students every week. |
| **Server owns the clock.** Per-student, from `started_at`. | A latecomer still gets their full time; a device with a wrong clock gains nothing. |
| **The LLM is optional everywhere.** | With no key, AI buttons hide and a full test can still be built from a pasted word list. Never make a path AI-only without a manual equivalent. |
| **A PDF is read in the browser, and only its picture pages are paid for.** No page limit. | The text layer costs nothing, needs no key and is not an upload at all, so capping it would be a limit on the free half — a 19-page word list reads in under a second. Picture pages — no text, or one image over most of the page with only a stamp on it — are named and counted, and the model reads them only when the teacher presses the button. Until then a mixed document's text is held back, so it goes in once, in page order. Batches are kept as they arrive, so a failure costs one batch and the button carries on from there. pdf.js is loaded only when a PDF is picked, and in its legacy build: the default one needs this year's browsers and fails on picture pages on anything older. |
| **Invites are links, not emails.** | No SMTP in the deployment, so no school spam filter can silently break onboarding. |

**The accepted trade-off:** the sprint sacrifices coverage. A slow student may
never reach word 35. This measures fluency and stamina alongside knowledge; it
is not an instrument for certifying that every student met every word.

## Architecture notes

- `packages/shared` is the keystone. Question payloads are Zod schemas defined
  once, so the LLM validator, the DB write, the API response and the React
  renderer cannot drift apart. Add new question types there first.
- **`stripAnswer()` is the only path from a stored question to a student.** Do
  not hand-roll a student-facing response; the tests assert no answer field
  survives for any type.
- `node:sqlite`, no ORM. It **rejects named parameters the SQL does not use** —
  spreading a row into a query with a hardcoded `NULL` column will throw. All DB
  access goes through `Db` in `db/index.ts`; swapping to better-sqlite3 means
  rewriting that file and nothing else.
- Migrations in `db/migrations.ts` are append-only, keyed on `user_version`.
  Never edit one that has shipped.
- Express 5 types path params as `string | string[] | undefined` — use the
  `param(req, name)` helper rather than casting.
- Jobs (`services/jobs.ts`) are in-process and single-instance by design. One
  teacher on one small server does not need a queue.

## Testing

`npm test` runs 273 tests with no network access. Integration tests drive the
real Express app over real HTTP on an ephemeral port against an in-memory
database — cookies, middleware order and JSON parsing are exercised, not
stubbed. `test/mock-llm.ts` stands in for an OpenAI-compatible provider, so the
whole composer can be tested without a key.

`signInAsTeacher()` creates an **admin** by default, because in most suites that
account is the person who set the instance up. Pass `{ isAdmin: false }` to test
what a colleague can reach.

Prefer adding a test that states the decision ("is strict about spelling — this
is the decision, stated as a test") over one that merely covers a line.

## Design

Follow `Voku Design Brief.md`. In short: one flat `#fafaf8` plane, no cards and
no shadows, Inter 500/600, structure from hairlines. Terracotta `#c65d3b` is the
only accent and is limited to the progress fill, the correct/selected answer,
and primary buttons — plus the dot in the wordmark, which is the one decorative
exception. Light theme only.

Because there is only one accent, **a wrong answer is shown in plain near-black,
not red.** Right and wrong are distinguished by the presence of the accent, not
by two colours.

## Things that are genuinely unfinished

- **Near-synonym distractors.** For adverbs of degree the model still offers
  wrong answers that are also correct — "kaum → scarcely" against *barely*,
  *rarely*, *hardly ever*. The distractor prompt names this exact failure and it
  fixed the other cases but not this one. The review step is the backstop.
- **The UI has never been seen rendered.** It has been verified by driving the
  API and inspecting the compiled CSS. Layout judgements are inference, and
  several real bugs have come from that — a heading that scrolled instead of
  wrapping, progress shown off screen, text below the contrast floor.
- Fill-in-the-blank needs a context sentence, and there is no UI field for one,
  so that format is effectively AI-only.
- No export. "Can I get these into my markbook?" has no answer yet.
- No teacher preview: nobody can see a test as a student sees it without a
  second browser profile.
- Passkeys were deliberately deferred. Credentials live entirely in
  `services/auth.ts`; nothing in the invite or role code assumes a password, so
  WebAuthn is additive when wanted.

## What a real model taught us

Everything below came from running against a live provider, and none of it was
visible against the mock.

- **Model choice dominates.** A reasoning model took 138 seconds per pass and
  intermittently returned null content; `openai/gpt-5.4-mini` does the same work
  in 6–12 seconds. Reasoning tokens count against `max_tokens`, so a model can
  spend its whole budget thinking and never answer — that case is retried and
  reported in plain words.
- **Every LLM call needs a timeout.** Without one a hung provider leaves a job
  in `running` for ever, which is indistinguishable from thinking.
- **Difficulty is an opinion, not a measurement.** Hence the relative threshold
  above.

## Conventions

- Comments explain *why*, especially where a choice looks odd (expiry checked
  before the submitted flag; `target_snapshot` copied at attempt start).
- User-facing copy says what to do, not what went wrong: "Scan your code to
  start", not "You are not signed in".
- Commit messages explain the reasoning, not the diff.
