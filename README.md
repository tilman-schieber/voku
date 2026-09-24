# voku

In-class vocabulary sprints for German students learning English.

The teacher pastes an English text (or uploads a PDF, or photographs a page),
trims the word list the AI
pulls out of it, and opens the test in class. Students scan a printed QR code on
their iPad and get **five minutes** — questions ramping from easy to hard, answer
as far as you can get.

**The score is `correct ÷ target`, and it is uncapped.** Reaching the target
(25 by default) is 100%; thirty-eight correct is 152%, and that is the number
worth chasing. The question pool is deliberately larger than the target so
strong students have runway.

The language model is optional. With no API key configured every AI button
hides and the app still builds and runs a complete test from a pasted word list.

---

## Quick start

```bash
npm install
npm run build
npm start
```

On first boot the server prints a one-time setup code. Open the address it
gives you, enter that code, and the account you create owns the instance —
finding the URL is not the same as being able to claim it.

```
  ┌─────────────────────────────────────────────┐
  │  voku is not set up yet.                    │
  │  Open http://localhost:3000                 │
  │  and enter this setup code:                 │
  │      MHGP-PD7J-39XK                         │
  └─────────────────────────────────────────────┘
```

For development, two processes — and on Windows they must be started separately
rather than through the root `npm run dev`, which joins them with `&`:

```bash
npm run dev --workspace=@voku/server   # API on :3000, rebuilt on change
npm run dev --workspace=@voku/web      # UI on :5173, proxies /api to :3000
```

```bash
npm test          # 273 tests, no network required
npm run typecheck
```

---

## How it fits together

```
packages/shared    Zod schemas for every question payload. The LLM validator,
                   the database write, the API response and the React renderer
                   all agree because they share one definition.
apps/server        Express 5 + node:sqlite. No ORM, no native dependencies.
apps/web           Vite + React + Tailwind. Two route trees on one origin:
                   /admin/* is the teacher, /s/* is the student, and / is a
                   signpost between them — anyone already signed in is
                   forwarded straight on.
```

The interface follows `Voku Design Brief.md`: one flat off-white plane, Inter
throughout, structure from hairlines and whitespace rather than cards, and
terracotta rationed to the progress fill, the correct answer, and primary
buttons. If terracotta appears anywhere else it is a mistake, not a flourish.

`npm run build` compiles the web app into `apps/server/public`, so production is
a single Node process serving both the API and the SPA.

### The four question formats

| Format | Needs a model? |
|---|---|
| Type the translation | no |
| Multiple choice · translation | no (distractors come from the other words on the list) |
| Multiple choice · definition | yes — someone has to write the definition |
| Fill in the blank | only if the word has no sentence in the source text |

The source text understands light markdown — `#` headings, `**bold**`,
`*italic*` — and students see the text itself with every trained word marked,
tapping one for its translation and dictionary form. Formatting and highlights
compose, so a word can be bold and trained at once.

When a test is being built, voku offers the words from earlier units that are
**due to come round again** — on a widening schedule, pulled sooner when the
class struggled with a word. Spreading repetitions out is one of the two
best-evidenced things that make vocabulary stick. It is judged for the class
rather than for individual students, and it only ever suggests: nothing is
carried over unless the teacher ticks it. A word that comes back is labelled
*from Unit 3* wherever students meet it.

Each student also sees their own **words to work on** — the words they got
wrong in a test and have not got right since, across every unit — and can
practise them. It is built from answers already kept, counts only closed tests
and questions they reached, and is never shown to the teacher. A word leaves the
list when it is got right in a later test.

Once a test is published, students can **practise** from their study list: the
word pairs, as often as they like. A missed word comes back a few cards later —
first as a choice built from the other words on the list, then to type again —
and only counts as known once it has been typed. It drills the pairs and never
the test's own
questions — those are identical for everyone and in a fixed order, so rehearsing
them would measure repetition rather than knowledge. Nothing about practice is
stored or reported.

After a test, the results board shows **which words the class did not know**,
with what students wrote instead. Rates count only students who reached the
question, since in a sprint most never see the last few.

### Two signals, not one

Word extraction returns **difficulty** (1–10) and **trickiness** (0–3) as
separate judgements, because they are separate things. *nevertheless* is hard
but honest; *become* is A1-easy and a total trap, since German *bekommen* means
to receive.

- **Difficulty** orders the sprint and drives the top-N cutoff.
- **Trickiness** — or being among the harder words in that particular test —
  decides which words become multiple choice. The threshold is relative
  because models calibrate difficulty differently.

That second rule is the anti-guessing mechanism. Wrong answers cost nothing, so
tapping a random option would be free marks — unless multiple choice is reserved
for words where guessing is not a free ride: either the wrong options are
genuine traps, or the word is hard enough that four plausible options is a real
question. It is never used to make an easy word easier. The trickiness *reason*
("German *Gift* means poison") is fed straight into the distractor prompt, and
the word list lets you mark a trap by hand when no model is connected.

The teacher's format mix is a set of **preferences, not quotas**. A text with
three tricky words cannot support ten multiple-choice questions, and the review
step reports the shortfall rather than inventing traps that are not there.

### The worksheet

Every word carries an English definition and an example sentence of its own, so
the same list that becomes the test also prints as a sheet to revise from. Both
fields can be written by hand; with a model connected, one button fills in
whatever is still blank. It only fills blanks — a sentence taken from the source
text, or anything you typed, is never written over.

The sheet comes in four variants, and the variant decides what a student is
allowed to see: everything, the German column left blank, the word missing from
its own example, or just the pairs. That blanking happens once, when the sheet is
built, so the printed page, the `.csv` and the `.docx` cannot disagree about it.
Print from the browser, or download either file to finish in Excel or Word.

---

## Decisions worth knowing about

These were settled deliberately. If you change one, change it knowing what it
was trading against.

- **Spelling is strict.** *recieve* is wrong. To make that liveable, a near miss
  shows "Almost — receive" (scored zero, but they see the form), and after the
  test the results board groups every rejected answer by what students actually
  typed — one tap accepts a variant, re-marks the whole class, and remembers it
  for future tests.
- **No shuffling.** Every student gets the same questions in the same order, so
  position 12 is directly comparable across the class. The clock does the
  policing: a second spent looking sideways is a second not scoring.
- **No behavioural telemetry.** Nothing records whether a student switched apps.
  The only personal data in the system is a first name and a score.
- **The live board is private.** No leaderboard, nothing projectable.
- **The clock belongs to the server.** Each student's five minutes starts when
  *they* tap Start, so a latecomer is not punished. Answers after the deadline
  are refused regardless of what the device's clock says.
- **The sprint sacrifices coverage.** A slow student may never reach word 35.
  This measures fluency and stamina alongside knowledge; it is not an instrument
  for certifying that every student met every word.
- **Attempts resume.** Answers are saved as they are given, so a dead iPad costs
  nothing. The teacher can also reset one student's attempt from the board.

---

## Deploying

**Changes ship by pushing to `main`.** GitHub Actions runs the typecheck and the
273 tests, and deploys only if they pass; `deploy/deploy.sh` then backs up the
database, builds, health-checks the running app, and puts the previous commit
back if it does not come up. `Working on voku.md` describes that loop from the
other end, including how to roll back.

The rest of this section is how the server was set up in the first place. It is
what you need when the machine is the problem rather than the code.

One container behind a reverse proxy. Copy `.env.example` to `.env`, edit it,
then:

```bash
docker compose up -d --build
docker compose logs app        # the setup code is printed here on first boot
```

The image is `node:22-slim` and builds both the web bundle and the server, so
the host needs nothing but Docker. The database lives on the host in `./data`
via a bind mount, which is what makes backup and restore possible without
touching the container.

The container publishes to `127.0.0.1:3200` only, so the reverse proxy is the
sole way in. `deploy/Caddyfile` has the matching block.

**HTTPS is not optional in practice.** `PUBLIC_BASE_URL` builds the QR login
links and decides whether cookies are marked `Secure`, and iOS will not always
open a plain `http://` link from a scanned code. Set it correctly *before*
printing the login cards.

Back up with `deploy/backup.sh` on a nightly cron (needs `sqlite3` on the host).
It uses `sqlite3 .backup` rather than `cp`, because copying a live WAL database
can produce a torn file — and a restore means stopping the container and
removing the `-wal` and `-shm` files, not just replacing the `.db`.

### Environment

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Origin for QR links; also decides the `Secure` cookie flag |
| `PORT` | Default 3000 |
| `DATABASE_PATH` | SQLite file. `/data/voku.db` in the container; relative paths resolve against `apps/server/` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Optional. Seeds the Settings page |
| `LLM_VISION_MODEL` | Optional. Only for photographing a page |

The API key is stored server-side and is never sent back to the browser. The
model is chosen from the provider's own catalogue in Settings, filtered as you
type. **Avoid reasoning models** — they are slow enough to be unusable here and
can spend their whole token budget thinking instead of answering.

---

## Accounts

**Teachers** sign in with a password. There is no sign-up page: the first
account is created by claiming the instance with the printed setup code, and
everyone after that joins by invitation.

An admin creates an invite link from *Account → Teachers*. The link is returned
to the browser and copied to the clipboard rather than emailed — send it however
you already talk to that colleague, which keeps a mail server and its spam
filter out of the deployment entirely. Links last seven days and work once.

Two roles:

| | Teacher | Admin |
|---|---|---|
| Own classes, tests and results | yes | yes |
| See anyone else's classes | no | no |
| Invite, promote or remove teachers | no | yes |
| Configure the language model | no | yes |

The language model is instance-wide — one account, one key, one bill — so a
plain teacher is told only *whether* the AI is available, never the provider,
the model, or that a key exists. The server enforces this regardless of what
the interface offers.

You cannot demote or remove the last admin, and a teacher who still owns
classes cannot be removed, since that would delete every result in them.

`npm run seed-admin -- you@school.de` still exists as a back door: it creates an
account, or resets a password if the email already exists. That is the recovery
path when an admin locks themselves out, since there is no password-reset email.

**Students** have no accounts and no passwords — each has one long-lived token
in their printed QR code, which you can rotate from the class page if a card
goes astray. The only personal data stored about a student is a first name and
their scores.
