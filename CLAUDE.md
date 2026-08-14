@AGENTS.md

# Working in this repo

A single-agent document intake workflow: read a UAE trade licence, extract structured fields against
a typed schema, validate them, and feed validation failures back to the model for a bounded
correction attempt.

`README.md` is the reviewer-facing overview and `docs/DECISIONS.md` holds the reasoning behind each
design choice. **Read `docs/DECISIONS.md` before changing anything structural** — most of what looks
arbitrary here was decided deliberately and the entry says why.

## Commands

```bash
pnpm dev                  # http://localhost:3000 — defaults to the stub provider, no key needed
pnpm verify               # typecheck + lint + tests. Run before every commit.
pnpm test:live            # opt-in: runs the rules against a real model. Needs a key, costs quota.
pnpm samples              # regenerate the demo specimens (needs google-chrome)
pnpm samples:malformed    # regenerate the defective-licence corpus for the live suite
```

## The one distinction everything turns on

Validation issues carry a `kind`:

- **`extraction`** — the model misread the page. Re-reading might fix it, so it feeds back into a
  correction attempt.
- **`document`** — the document really is like that. An expired licence is expired however many
  times you read it; an invoice does not become a licence on a second look.

Only `extraction` issues trigger a retry. Getting this wrong burns retries "correcting" true
findings, and pressing a model to re-read something it read correctly invites it to invent an answer
that passes. **When adding a rule, decide its `kind` first** — a `document` issue carries no `hint`,
because there is nothing useful to tell the model.

## Invariants

**No document content in logs, ever.** Not field values, not bytes. `LogValue` in `src/lib/obs/log.ts`
is deliberately too narrow to express a field value, so logging one is a compile error rather than a
review catch. `tests/obs/redaction.test.ts` proves it end to end. If you widen that type to `unknown`
or `object`, the guarantee is gone. `managerName` names a private individual and is the value that
matters most.

**No real documents, anywhere.** Every specimen is generated from HTML by `samples/*.sh`. A real
licence must never enter this repo — it is public, and the generators exist precisely so there is no
path by which one could. Use a real document as a reference for the *schema* if you have one, then
throw it away.

**Nothing above `src/lib/providers/` imports a vendor SDK.** `ExtractionProvider` is the whole
surface. `retry` and `fault` are decorators over it; adding a provider is a new folder plus a case in
`providers/index.ts`.

**The schema is the prompt.** `.describe()` on each field ships to the model as a JSON Schema
description attached to that field, so it is the highest-leverage prompt surface in the codebase.
Changing wording there changes model behaviour — verify with `pnpm test:live`, not by reasoning.

**Rules are pure functions of `(record, { now })`.** `now` is injected so expiry rules are testable at
a fixed date. Keep them free of clocks, network and model.

## Layout

```
src/lib/
  schema/trade-licence.ts   the swappable file — a new document type is a sibling
  validate/                 issue taxonomy (issue.ts) + pure rules (rules.ts)
  providers/
    types.ts index.ts       the interface, and the one place a provider is chosen
    gemini/ stub/           adapters; stub is fixture-backed and needs no key
    decorators/             retry (transient failures), fault (injection)
  agent/run.ts              the loop itself, and its three terminal states
  obs/                      redacting logger, run log, metrics, cost
```

A second document type should touch **only** `schema/` and `validate/rules.ts`. If a change reaches
further than that, the split between reusable core and bespoke edge has broken.

## Gotchas, all of them found the hard way

- **Module state is not shared between server components and route handlers.** They are separate
  bundles. `metrics()` called from `page.tsx` returned zero while `/api/health` reported three runs
  in the same process. The UI reads metrics over HTTP for this reason.
- **Gemini free tier: 20 requests/day and 5/minute, per model, per project.** Counted separately per
  model, so switching models gives fresh headroom. `pnpm test:live` paces itself; override with
  `LIVE_TEST_PACE_MS` on a paid tier.
- **A blank env var is present, not absent.** `GEMINI_API_KEY=` once refused to boot under the stub,
  and `COST_INPUT_PER_MTOK=` coerced to `0` and reported a configured price of zero. Everything goes
  through `blankAsUndefined` in `config.ts`; keep it that way.
- **Gemini's `responseSchema` is an OpenAPI subset, not JSON Schema.** It rejects `$schema` and
  `additionalProperties`, and spells nullability `nullable: true` where Zod emits `anyOf: [T, null]`.
  `providers/gemini/schema.ts` converts, and is unit-tested without a model call.
- **Regenerating samples rewrites their hashes.** The stub keys fixtures off SHA-256 via the
  manifest, so run `pnpm samples` and update `providers/stub/fixtures.ts` together.
- **`next dev` rewrites `AGENTS.md`.** Committing that change with your work keeps the tree clean;
  removing it just recreates it.

## Conventions

- **No `any`.** Strict TS, `noUncheckedIndexedAccess` on. Types derive from Zod — a field is declared
  once.
- **Comments explain *why*, never *what*.** Where a decision looks odd, the comment says what was
  tried and what broke. Several here record a bug that a test now pins.
- **Named exports; one responsibility per file.**
- **The offline suite stays offline, free and deterministic.** No network, no key, no real clock.
  Anything needing a provider goes in `tests/live/` and is excluded from `pnpm test`.
- **When a bug is found, pin it with a test before fixing it.** Most tests here exist because
  something actually broke; the comment above them says what.
