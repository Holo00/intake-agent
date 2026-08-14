# Document intake agent

Reads a UAE trade licence, extracts structured fields against a typed schema, validates them, and —
when validation fails — hands the specific failures back to the model and tries again.

**Anyone can get a model to return JSON. This is about what happens when it returns the wrong JSON.**

```
             ┌──────────────────────────────────────────────┐
             │                                              │
  document ──┴──► extract ──► validate ──► clean? ──► yes ──┴──► valid / corrected
                     ▲            │
                     │            no
                     │            │
                     │      re-readable? ──► no ──► needs_review
                     │            │
                     └── hints ◄──┘        (bounded: 2 attempts, then stop)
```

Three terminal states, and the loop returns one of them or fails cleanly. There is no fourth state
and no partial success.

| Status | Meaning |
|---|---|
| `valid` | Read cleanly on the first attempt. |
| `corrected` | First attempt failed validation; the model was given the failures and its second attempt passed. |
| `needs_review` | Still failing after the attempt budget, **or** the licence itself has a problem no re-reading can fix. Never auto-approved. |

---

## Run it

It runs in two modes, and the difference matters.

### Real extraction — needs a Gemini API key

```bash
pnpm install
cp .env.example .env.local          # set LLM_PROVIDER=gemini and paste GEMINI_API_KEY
pnpm dev                            # → http://localhost:3000
```

**This is the mode that actually reads documents.** A [Gemini API key](https://aistudio.google.com/apikey)
is required — the model reads the document bytes and returns the extracted fields, and nothing
substitutes for that. The free tier is enough to try it: **20 requests per day and 5 per minute, per
model, per project**, which a few clicks will reach.

### Zero-setup — no key, no network, no real extraction

```bash
pnpm install
pnpm dev                            # → http://localhost:3000, LLM_PROVIDER=stub by default
```

Without a key it falls back to a stub provider serving canned responses keyed by the SHA-256 of each
sample. **The model call is the one thing that is not real** — the loop, the schema, the validation
rules, the correction step, the metrics and the UI all are. It exists so the repo can be cloned and
seen working in under a minute, and so CI can exercise the agent loop deterministically. The page
says plainly when it is running this way.

```bash
pnpm verify             # typecheck + lint + 95 tests, all offline
pnpm samples            # regenerate the demo specimens (needs google-chrome)
pnpm samples:malformed  # regenerate the defective-licence corpus
pnpm test:live          # run the rules against a real model — needs a key, spends quota
```

`pnpm test:live` is the one that checks the **validation rules against reality** rather than against
fixtures: seven genuinely defective licences — expiry before issue, a date predating the UAE, an
illegible licence number, no activities — where the model reads the page correctly and each rule is
supposed to object. Plus a clean control, without which a rule that fired on everything would still
pass. It is opt-in and CI does not run it, because a suite that needs a funded API key to go green is
a suite that gets ignored.

## What to look at

Six sample buttons, one click each. **They are also downloadable**, so you can drop them into the
upload box and exercise the real path rather than watching a scripted one.

Licences:

- **Clean licence** → `valid`. One attempt, no issues.
- **Expired licence** → `needs_review` **in one attempt, not two.** The extraction is perfect; the
  licence expired in 2024. Decision 5 below — this is what the whole design turns on.
- **Awkward layout** → `valid`. Activities as prose, seal over the text, Abu Dhabi `CN` format.
- **Photographed copy** → `valid`. A skewed, glare-lit, noisy, quality-32 JPEG photo of that same
  licence. It reads correctly, which is exactly what decision 2 buys — a text-extraction pipeline
  returns *nothing* here.

Not licences at all, which is the commonest thing an intake endpoint receives after the correct
document — both `needs_review` in one attempt:

- **Tax invoice** → `NOT_A_TRADE_LICENCE`. Deliberately the hard rejection: a company name in both
  scripts, a UAE address, an issue date, a reference number, an authority-shaped header. Every
  individual signal a naive classifier might key on is present, and only the document as a whole
  says "invoice".
- **Blank page** → `NOT_A_TRADE_LICENCE`. The blank back of a duplex scan.

**Then tick a fault and run any sample again.** That is the one to look at: the first attempt's
output is corrupted on the way back from the real provider, validation catches it, the model gets a
specific hint, and the second attempt passes. The panel shows both attempts and diffs the field that
changed.

> **Why inject the fault instead of finding a document that breaks it?** Because I measured it, and
> a current model reads all four licence specimens correctly — including the photograph. Engineering a
> document to defeat a frontier model is fragile (it stops working the week the model improves) and
> quietly dishonest. **The correction loop is insurance. On a legible document with a current model
> it never fires, and that is the correct outcome.** Full reasoning in decision 11.

The **Session metrics** panel fills in as you go — status breakdown,
correction rate, p50/p95, what share of latency is the model, and how many of your tokens went on
retries. Same data as `GET /api/health`, which also reports the active provider, model and limits.

## The six decisions that matter

Full reasoning in [docs/DECISIONS.md](docs/DECISIONS.md).

**1. A UAE trade licence, because I have run extraction against real ones in production.** Picking a
document type I did not know would have meant asking a model to invent the schema and the validation
rules, leaving no honest answer to *"why did you validate it that way?"* — the only interesting
question here. Trade licences are also genuinely hard: bilingual Arabic/English on one page, RTL
beside LTR, day-first dates, labels that differ between the emirates and the free zones, seals
printed over text. **The same loop fits any document type; only the schema changes.**

**2. Document bytes go straight to a vision model — no OCR, no text-extraction step.** Flattening a
bilingual licence to a text stream destroys the layout, and the layout is what tells you which value
belongs to which field. It also returns nothing at all on a scan, and a large share of real licences
are photographs with a stamp over the licence number. **The Photographed copy sample is this decision
being tested rather than asserted.**

**3. One Zod schema is the single source of truth** — it generates the JSON Schema sent to the model
as its output contract, the runtime validator, and the TypeScript type. Field guidance lives in
`.describe()`, so it reaches the model attached to the field it governs rather than as prose the
model has to map onto field names itself.

**4. A provider interface with two real implementations.** Not speculative abstraction — the adapter
earns its place immediately, because Gemini's `responseSchema` is an OpenAPI subset that rejects
`$schema`/`additionalProperties` and spells nullability differently from JSON Schema. That conversion
is isolated and unit-tested without a model call.

**5. Validation issues are split into `extraction` and `document`, and only `extraction` triggers a
retry.** A misread date is worth another look; an expired licence is not, and an invoice does not
become a licence on a second reading. Collapsing the two is how these pipelines usually go wrong —
they burn retries "correcting" a true finding, and pressing a model to re-read a date it read
correctly invites it to invent one that passes.

**6. The model is given a way to say "this is not the document you asked for".** `isTradeLicence` is
the first field in the schema and the only one that is never null; the identity fields are nullable
precisely so a rejected document has somewhere honest to land. Without it, a model handed an invoice
finds something that looks like a licence number and returns a record describing nothing. Rejection
short-circuits every other rule, because one clear reason beats eleven symptoms of it.

## Production-mindedness, concretely

- **No document content in logs, and a test that proves it.**
  [`tests/obs/redaction.test.ts`](tests/obs/redaction.test.ts) runs a document through the pipeline, captures
  everything written to the log sink, and fails if any extracted value appears. `LogFields` is typed
  so narrowly that logging a field value is a compile error, not a code-review catch.
- **Fail fast on bad config.** The environment is parsed once at boot; a provider selected without
  its credential refuses to start rather than 500-ing on the first upload.
- **One canonical error type** crosses the provider boundary, with stable codes and HTTP mappings.
  Vendor error text is never forwarded to the client — provider errors can echo request content.
- **A hand-rolled abort.** The Gemini SDK takes a `timeout` but accepts no external `AbortSignal`, so
  a caller cannot cancel a call in flight. The adapter races the promise against one, which is what
  lets the loop bound its *total* time rather than per attempt.
- **Input limits before the bytes reach the model** — MIME allowlist, size ceiling, correct 413/415.
- **`x-request-id` on every response**, echoed in every log line, correlated with a document SHA-256
  so a run can be traced without storing what was in it.
- **Two retry axes, kept apart.** The agent loop retries because the *answer* was wrong; `withRetry`
  retries because the *call* failed (429, 503, dropped connection). Collapsing them would let a rate
  limit consume one of the two correction attempts. Exponential backoff with **full jitter** — at
  volume the jitter matters more than the backoff, or every request throttled in the same second
  retries in the same later second and reproduces the spike.
- **Cost accounting that refuses to guess.** Tokens are recorded per attempt; cost is derived only
  when rates are configured via env, because a stale hardcoded price produces confident, wrong money.
  The price-free number is the useful one: **a correction resends the document, the previous answer
  and the errors, so attempt two typically costs more than attempt one.** Budget is `correction rate
  × that multiple`.
- **`GET /api/health` is operational, not a ping** — status breakdown, correction and needs-review
  rates, p50/p95 latency, what share of it is the model, token and spend totals, and the validation
  rules ranked by how often they fire. That ranking is the feedback loop: a rule firing constantly is
  a schema or prompt problem, not a validation problem.
- **95 tests**, all offline: validation rules, document rejection, the schema converter, the agent
  loop across all three terminal states, the injected faults, the budget exhaustion path, backoff,
  jitter and provider-stated delays, deadline cancellation mid-backoff, cost maths, environment
  parsing, and the redaction proof.
- **A `/leak-check` command** ([`.claude/commands/leak-check.md`](.claude/commands/leak-check.md))
  that proves the redaction guarantee against a running instance rather than reviewing the code for
  it: run every specimen through, capture the logs, and search them for values known to have gone in.
- **Fault injection as a decorator** over the provider interface, so the failure path can be
  exercised on demand against the real model rather than hoped for.

## Deploying it

[`railway.json`](railway.json) pins the build and start commands, and points Railway's healthcheck at
`/api/health` — which reports the active provider and model rather than a bare 200, so a deploy that
comes up with the wrong configuration fails the check instead of serving quietly.

`next start` already honours `$PORT` and binds all interfaces, so nothing else is needed. Set
`LLM_PROVIDER=gemini` and `GEMINI_API_KEY` as service variables; without them the instance serves the
stub, and the page says so.

## Deliberately out of scope

Auth, users, multi-tenancy, a database, queues, file persistence, more than one document type, and
any orchestration framework. [docs/DECISIONS.md](docs/DECISIONS.md) says why for each.

It closes with **what I would add before calling this production** — not a wishlist but a position on
each: database-enforced tenant isolation rather than a `WHERE` clause developers must remember,
envelope encryption with blind indexes where fields must stay searchable, the three roles an intake
pipeline cannot collapse into one, where the reusable core ends and the bespoke edge begins, and what
observability at real volume needs beyond what is here. **The largest gap is evaluation against a
labelled set** — a handful of samples and my own judgement are not a substitute, and I would rather
say so than imply otherwise.

## Samples are synthetic by construction

All six specimens are generated from HTML by [`samples/generate.sh`](samples/generate.sh) via
headless Chrome; the photographed one is then put through
[`samples/degrade.py`](samples/degrade.py), which applies the physical effects of photographing paper
— perspective, rotation, uneven lighting and glare, warm paper tone, sensor noise, heavy JPEG. No
text is altered.

No real licence was used at any point, and no real entity, licence number or address is represented.
Regenerating rewrites the manifest hashes the stub keys off, so the fixtures cannot drift from the
files.

## Stack

Next.js 16 (App Router) · TypeScript, strict · Zod 4 · `@google/generative-ai` · Vitest · Tailwind 4.

```
src/lib/
  schema/trade-licence.ts    the swappable file: fields, descriptions, types
  validate/                  issue taxonomy + pure cross-field rules
  providers/
    types.ts                 the ExtractionProvider interface — the whole surface
    index.ts                 the one place a provider is chosen and composed
    gemini/                  adapter + JSON Schema → Gemini schema converter
    stub/                    canned provider + fixtures, keyed by document hash
    decorators/              retry (transient failures) and fault (injection)
  agent/                     the loop, instructions, result types
  obs/                       redacting logger, run log, metrics, cost
  config.ts  errors.ts       boot-time env parse, canonical error type
```

The only files a second document type should touch are `schema/` and `validate/rules.ts`.
That is the test of whether the split between reusable core and bespoke edge is real.

[`CLAUDE.md`](CLAUDE.md) carries the working notes for anyone — human or agent — changing this code:
the invariants, and the gotchas that cost time to find.
