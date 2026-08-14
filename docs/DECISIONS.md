# Decisions

Written during the build, 2026-08-13. Each entry is a decision that could reasonably have gone the
other way, so the reasoning is worth more than the outcome.

---

## 1. The document is a UAE trade licence

**Because I have run extraction against real ones in production**, and the failure modes below are
things I have watched happen rather than things I imagine might.

Picking a document type I did not know would have meant asking a model to invent both the schema and
the validation rules, and then having no answer to *"why did you validate it that way?"* — which is
the only interesting question about this project.

Trade licences also happen to be genuinely hard in a useful way: bilingual Arabic/English on one
page, right-to-left beside left-to-right, day-first dates, field labels that differ between the seven
emirates and the free zones, and seals printed over the text.

**The same loop works for any document type — only the schema changes.** That is why
[`src/lib/schema/trade-licence.ts`](../src/lib/schema/trade-licence.ts) is a standalone file that
nothing else hardcodes against.

**Tested against a real one.** Checking the schema against a genuine DIEZ free-zone licence found
three gaps: it prints the licence holder and the trade name as *separate* fields where I had one; it
carries a **Company Manager** block naming a private individual, which I had missed entirely; and it
breaks the address into premises, building and area rather than one line. The first two are now in
the schema — a one-file change, which is the claim this file makes. The structured address is not,
and is listed below as outstanding rather than quietly dropped.

The manager field matters beyond coverage: it is the only field naming a person rather than a
company, so it is what makes the extracted record unambiguously personal data — and it is now the
first value the redaction test proves absent from the logs.

## 2. Document bytes go straight to a vision model. No OCR, no text extraction

The obvious pipeline is PDF → text → model. It is wrong here for two reasons.

A text-extraction pass destroys the two-dimensional layout, and the layout *is* the information: on a
bilingual licence, knowing that a value sits in the right-hand column under an Arabic label is what
tells you which field it belongs to. Flattened to a text stream, the Arabic and English values for
seven fields become fourteen strings in unreliable order.

And it returns nothing at all on a scan. A large share of real licences arrive as photographs or
scanned copies, frequently with a stamp over the licence number.

Passing the raw bytes to a vision-capable model handles both, and is less code.

## 3. One Zod schema is the single source of truth

`tradeLicenceSchema` produces three artefacts that would otherwise drift:

1. the JSON Schema sent to the model as its output contract (via `z.toJSONSchema`),
2. the runtime validator applied to what comes back,
3. the TypeScript type used everywhere downstream.

Field descriptions live in `.describe()` rather than in the prompt, because they reach the model
*attached to the field they govern* instead of as prose it has to map onto field names itself. That
makes the schema the main prompt surface in the codebase.

## 4. A provider interface, with Gemini and a stub behind it

[`ExtractionProvider`](../src/lib/providers/types.ts) is one method. Everything vendor-specific —
how a PDF is attached, how structured output is constrained, how errors are named — sits behind it,
so no vendor type is imported above the adapter layer.

**This is not speculative abstraction: it has two real implementations.** The stub is a genuine
second provider, which is what keeps the boundary honest.

The adapter earns its place immediately. Gemini's `responseSchema` is an OpenAPI subset, not JSON
Schema — it rejects `$schema` and `additionalProperties`, and expresses nullability as
`nullable: true` where JSON Schema uses `anyOf: [T, null]`. That conversion lives in
[`gemini/schema.ts`](../src/lib/providers/gemini/schema.ts) and is unit-tested without a model call.

**On Claude:** adding it is one file implementing one interface. It is deliberately not in the repo,
because an adapter that has never been executed is a liability rather than a credential — I would
rather ship one provider that demonstrably works than two where the reviewer cannot tell which.

## 5. Validation issues are split into `extraction` and `document`

**The most important decision here.**

- `extraction` — the model misread the page. Re-reading might fix it, so it is worth a retry.
- `document` — the licence really is like that. An expired licence is expired however many times you
  look at it.

Collapsing the two is the standard way these pipelines go wrong: they burn retries "correcting" a
true finding, and report a genuine compliance problem as a parsing failure. Worse, pressing a model
to re-read a date it read correctly invites it to invent one that passes validation.

So `LICENCE_EXPIRED` carries no `hint` and never triggers a retry — it goes straight to
`needs_review`. Try the **Expired licence** sample: one attempt, not two.

## 6. Two attempts, not five

The correction is worth having: a joined activity block or a transposed date pair is exactly the kind
of miss a specific hint fixes on the second pass.

Beyond that, the returns collapse. If a model has read a field wrong twice given precise feedback,
the third attempt is not a better read — it is a more expensive one, and it increases the chance of a
confidently wrong answer that happens to satisfy the rules. The budget is
[configurable](../src/lib/config.ts) and defaults to 2.

The whole loop shares one deadline rather than one per attempt, so a 45s timeout means 45s total.

See decision 11 for how the loop is actually demonstrated, which turned out to be the harder problem.

## 7. No database

The brief says *returns a clean record*. Returns, not persists.

The real reason is sharper: storing extracted trade-licence fields creates PII at rest, which needs
encryption, a retention policy and a deletion path. Doing that properly is well beyond a half-day
demo; doing it *improperly* — plaintext licence numbers and holder names in a public demo repo —
would contradict the exact discipline this project is meant to demonstrate.

So [`run-log.ts`](../src/lib/obs/run-log.ts) keeps the *shape* of an audit trail — an append-only
ring buffer of request id, document hash, status, attempt count, issue codes, timings — and none of
the liability. There is no field value in it. See `/api/health`.

## 8. Next.js, but only as the shell

One Next.js app: one repo, one deploy, and a working link — which is the actual deliverable here.
NestJS is the better production answer for this service and the wrong answer for a half-day build,
because it doubles the deployment work for a difference a reviewer would never see.

**So the choice is confined to the edge rather than baked through the logic.** Nothing under
`src/lib/` imports `next` or `react` — the schema, validation rules, provider interface, agent loop,
logging and config are all plain TypeScript. Five files touch the framework, all under `src/app/`,
and the route handler is about seventy lines of *read the multipart, call `runIntake`, map errors to
status codes*.

Moving this behind NestJS, a queue worker or a Lambda means rewriting that one file. That is the
practical test of whether a framework choice was a decision or an accident.

Five runtime dependencies in total, three of which are the framework itself: `next`, `react`,
`react-dom`, `zod`, `@google/generative-ai`.

## 9. No orchestration framework

No LangChain, no LlamaIndex. The provider SDK directly.

The whole agent loop is one function in [`run.ts`](../src/lib/agent/run.ts) — about 125 lines of code. A framework would add a
dependency, an abstraction to learn, and a layer between me and the failure modes that matter here —
in exchange for nothing this build needs.

## 10. A stub provider, so it runs with no API key

`LLM_PROVIDER=stub` is the default. Clone the repo, `pnpm install && pnpm dev`, and the full loop
runs — real validation, real correction, real UI — against canned model responses keyed by the SHA-256
of each sample.

Two payoffs: a reviewer sees the whole thing working in under a minute with no signup, and the agent
loop is testable in CI deterministically, with no network and no mocked SDK internals.

## 11. The failure is injected, not engineered

**This one reversed a plan, and the reversal is the interesting part.**

The build assumed the model would fumble a deliberately awkward specimen — activities set as a
numbered paragraph rather than a list — and that catching and correcting that miss would be the
demonstration. It was measured rather than assumed, and the assumption was wrong.

`gemini-3.6-flash` reads all four specimens correctly on the first attempt, including
`scan.jpg`: a skewed, glare-lit, sensor-noisy, quality-32 JPEG photograph of a licence. Every field,
both scripts, dates normalised from day-first to ISO, six activities split correctly out of a prose
block.

That left a correction loop that never runs, and two bad options:

- **Engineer a document that defeats the model.** Fragile — it stops working the week the model
  improves — and quietly dishonest. A reviewer who has spent any time with these systems would see a
  demo tuned to make a model fail.
- **Run the demo on a weaker model.** Worse. Same dishonesty, less craft.

**So the fault is injected and labelled.** The first attempt's output is corrupted on the way back
from the real provider; everything after that is genuine — real validation, real hints, a real second
call to Gemini, a real corrected record. The three faults are misreads I have actually seen
(activities joined into one string, issue/expiry transposed, Arabic name transliterated rather than
transcribed), not inventions chosen to suit the rules.

Two things fall out of it that the original plan would not have produced:

1. **`withFault` is a decorator over `ExtractionProvider`** ([fault.ts](../src/lib/providers/decorators/fault.ts)),
   so the loop and the route do not know it exists. The provider interface pays for itself a second
   time.
2. **The honest headline is better than the one I set out to write.** The correction loop is
   insurance. On a legible document with a current model it never fires, and that is the correct
   outcome — the value is that the system knows the difference between a clean read, a miss it can
   recover from, and a document a human needs to see.

Measured, not assumed, is the whole point. The plan said the model would fail; it did not.

## 12. Two retry axes, kept apart

`IntakeError.transient` existed for a while with nothing consuming it, which meant a `429` from the
provider failed the entire run. That was a bug of omission, and fixing it exposed a distinction worth
making explicit:

- **The agent loop retries because the _answer_ was wrong** — validation failed.
- **`withRetry` retries because the _call_ failed** — a 429, a 503, a dropped connection.

Collapsing them is tempting and wrong in both directions: a rate-limited request would consume one of
the two correction attempts, and a genuinely wrong answer would be re-sent because the network
hiccuped. So transient retry is a separate decorator sitting closest to the network, and only
`transient` codes qualify — a 401 or a retired model fails identically forever, and retrying those is
a slower way to return the same error.

Backoff is exponential with **full jitter**. At volume the jitter matters more than the backoff:
without it, every request rate-limited in the same second retries in the same later second and
reproduces the spike. The backoff also honours the run deadline, so a request whose caller has given
up does not sit out a 30-second sleep.

**On cost.** Tokens are recorded per attempt and cost is derived — but only when rates are configured
via the environment. Model prices are configuration, not facts this codebase should assert: they
change, they differ by region and tier, and a stale hardcoded rate produces confident, wrong money.
The genuinely useful number needs no prices at all, which is why it is reported separately: **a
correction resends the document, the previous answer and the validation errors, so attempt two
typically costs more than attempt one.** Budgeting an intake pipeline is `correction rate × that
multiple`, not `correction rate × a bit`. `/api/health` reports both.

---

## What I would add before calling this production

The demo stops here deliberately. Below is what is missing and what I would actually do about it —
positions rather than a wishlist, because "add observability" is not a plan.

### Data isolation, if this served more than one client

The hard part is not the schema, it is guaranteeing that a query can never cross a tenant boundary.
Application-level `WHERE tenant_id = ?` is one forgotten clause away from a breach and it does not
survive an auditor asking *"what enforces that?"* — the honest answer has to be something the
database enforces, not something the developers remember. **Postgres row-level security with the
tenant set per connection**, so an unscoped query returns nothing rather than everything, plus a
schema-per-tenant option for clients whose procurement demands physical separation. Isolation gets
its own tests, and they are the ones I would run in CI on every commit.

### Persistence and an audit trail

Encrypted at rest, with a retention policy and a deletion path, because extracted licence fields are
personal data. Where fields must stay searchable, envelope encryption with a blind index on the
searchable column — a deterministic HMAC — so lookups work without the plaintext being present. The
audit trail records who saw what and when, and is append-only.

### Authentication and role-based access

An intake pipeline has at least three roles that must not collapse into one: the service posting
documents, the reviewer resolving `needs_review`, and the administrator changing thresholds or
schemas. Short-lived tokens, roles checked at the route boundary, and every review action attributed
to a person. For field users on phones this means device-appropriate session lengths and a re-auth
step before anything irreversible, not a permanent login.

### Evaluation against a labelled set

**The largest gap, and I would not claim otherwise.** Right now "does it work?" is answered by four
samples and my judgement. The honest version is a few hundred labelled documents, per-field accuracy
rather than a single pass rate, and a regression gate that blocks a prompt, schema or model change
that makes any field worse. The review queue below is what produces those labels: every human
correction is a labelled example, so the system that fixes today's errors is also the system that
measures tomorrow's.

### A human review queue

`needs_review` currently means "shown in the UI". It should mean a reviewer sees the document beside
the extracted fields, corrects them, and the correction is recorded as ground truth.

### Observability and cost control at volume

**Partly built — see decision 12.** What is here: structured logs with no document content, request
id and document hash correlation, per-attempt timings and tokens, the retry-token multiple, latency
percentiles, issue-code ranking, and cost when rates are configured. What is missing at real volume:
export to a metrics backend rather than a module-level ring buffer, alerting on correction rate and
`needs_review` rate as leading indicators of a model or document-mix change, a per-tenant spend cap
with a hard stop, and sampled request tracing.

### Reusable core versus bespoke edge

If this were the first of several document pipelines, the split is already visible in the tree: the
loop, the provider boundary, the validation kinds, the observability and the error taxonomy are the
reusable core; the schema file and the rule set are the bespoke edge. **The test of whether that
split is real is whether the second document type touches any file outside `schema/` and
`validate/rules.ts`.** It should not. I would resist extracting a package until the third pipeline,
because the second one is what reveals which abstractions were imagined.

### Smaller, but real

- **Async processing.** A 45-second synchronous request is fine for one document and wrong for a
  batch. Queue, job id, webhook or poll.
- **Rate limiting and abuse controls** on a public endpoint that spends money per request.
- **Per-field confidence**, so a reviewer's attention goes to the two fields the model was unsure
  about rather than all eleven.
- **Multi-page and multi-document handling.** Today it assumes one licence per file.
- **A structured address.** Real free-zone licences break it into premises number, building name and
  area; the schema currently collapses that into one string, which is lossy for anything that needs
  to match on location. Found by checking the schema against a genuine DIEZ licence — see decision 1.
