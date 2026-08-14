# Leak Check

Prove that no document content, extracted field value, or credential can escape through logs,
API responses, the client bundle, the health endpoint, or the repository itself.

This is a **proof, not a review**. Reading the code and concluding "looks fine" is the failure mode
this command exists to replace — run the pipeline, capture everything it emits, and search that
output for values you know went in. A grep that finds nothing is evidence; an opinion is not.

## Arguments

- **$ARGUMENTS**: optional scope. Omit to run everything. Pass `static`, `runtime`, `client`, or
  `repo` to run one phase.

## The invariants

Everything below is a rule this codebase already claims to hold. The job is to try to break each one.

1. **No extracted field value ever reaches a log.** Not the licence number, company name, address,
   dates, or activities. Field *names* and issue *codes* are fine and are the point.
2. **No document bytes reach a log**, in any encoding — no base64, no hex, no excerpt.
3. **No provider error text reaches the client.** Vendor errors can echo request content.
   `IntakeError.toPublic()` is the only thing that crosses the wire; `logDetail()` is server-side.
4. **No credential reaches the browser.** No API key in the client bundle, no `NEXT_PUBLIC_` secret.
5. **`/api/health` is safe to expose unauthenticated** — hashes, codes, counts and timings only.
6. **The run log holds no personal data**, so it stays legal to keep in memory and to display.
7. **Nothing real is committed.** No `.env.local`, no genuine document, no key in git history.

## Workflow

### 1. Static — where a value could enter a log

Read `src/lib/obs/log.ts` first and confirm the `LogValue` union still cannot express a document
field. That type is the primary defence: if it has widened to `unknown`, `any`, `object`, or
`Record<string, unknown>`, the compile-time guarantee is gone and everything else here is secondary.

Then hunt for values reaching a sink:

```bash
# Logging calls that mention a payload rather than a name or code.
grep -rnE "log\.(info|warn|error)\([^)]*\b(record|raw|document|bytes|payload|result|response|data)\b" src/

# Any direct console use in the domain layer — it bypasses the typed sink entirely.
grep -rn "console\." src/lib/

# Serialising something wholesale is the usual way a record slips out.
grep -rn "JSON.stringify" src/lib/ src/app/api/

# Error paths are the classic leak: a cause forwarded instead of a code.
grep -rnE "message: .*(cause|error)\.|toPublic|logDetail" src/
```

For each hit, decide: does this expression carry a *value* from the document, or only a name, code,
count, hash or duration? Names and codes are safe by design. Values are the finding.

Confirm `fieldSummary()` still returns field names and null-ness only, and never the values.

### 2. Runtime — the actual proof

Static analysis misses whatever a dependency logs. Run the thing and search its output.

```bash
pnpm build
pnpm start > /tmp/leak-check.log 2>&1 &
# wait for http://localhost:3000/api/health to answer

for s in clean expired awkward; do
  curl -s -X POST http://localhost:3000/api/intake -F "file=@public/samples/$s.pdf;type=application/pdf" -o /dev/null
done
curl -s -X POST http://localhost:3000/api/intake -F "file=@public/samples/scan.jpg;type=image/jpeg" -o /dev/null
curl -s -X POST http://localhost:3000/api/intake -F "file=@public/samples/clean.pdf;type=application/pdf" -F "fault=join_activities" -o /dev/null
```

Now search the captured log for every value that went in. The known-good values are in
`src/lib/providers/stub/fixtures.ts` — use that file as the source of truth rather than retyping
them, and include the Arabic strings, which are the ones most likely to be missed.

The manager names come first deliberately: they are the only values naming a **private individual**
rather than a company, so they are the ones whose escape matters most.

```bash
for v in "Yousef Abdulrahman Al Marzooqi" "يوسف عبدالرحمن المرزوقي" \
         "Fatima Hassan Al Balushi" "فاطمة حسن البلوشي" \
         "Rashid Omar Al Suwaidi" "راشد عمر السويدي" \
         "784512" "Al Maha" "الماها" "Gulf Horizon" "SHAMS-11029" "أفق الخليج" \
         "CN-2094771" "Nakheel" "النخيل" "Al Shafar" "Mussafah" "Al Messaned" \
         "2026-01-15" "2027-01-14" "Land Freight" "General Trading"; do
  n=$(grep -Fc "$v" /tmp/leak-check.log 2>/dev/null || echo 0)
  [ "$n" != "0" ] && echo "LEAK: $v appears $n times"
done
```

**Any hit is a finding.** Then confirm the log is still *useful* — redaction that destroys
debuggability has traded one bug for another:

```bash
grep -c "intake.completed" /tmp/leak-check.log   # runs are recorded
grep -o "ACTIVITIES_NOT_SPLIT" /tmp/leak-check.log | head -1   # failures are named
grep -o "documentSha256" /tmp/leak-check.log | head -1         # runs are correlatable
```

Also check the document bytes did not arrive in some encoded form:

```bash
grep -cE "JVBERi0|/Type\s*/Page|data:application/pdf|base64," /tmp/leak-check.log
```

### 3. Runtime — the health endpoint and error responses

`/api/health` is unauthenticated. Everything in it is public.

```bash
curl -s http://localhost:3000/api/health > /tmp/health.json
```

Re-run the same value loop against `/tmp/health.json`. Then confirm error responses carry a code and
our own message, never the vendor's text or a stack trace:

```bash
curl -s -X POST http://localhost:3000/api/intake -F "file=@package.json;type=application/json"
curl -s -X POST http://localhost:3000/api/intake -H "content-type: application/json" -d '{}'
```

Each should return a stable code, a message written in this repo, and nothing else. If a provider
message, file path, or stack frame appears, that is a finding.

To exercise the provider error path, temporarily point `GEMINI_API_KEY` at a wrong value and confirm
the response is `PROVIDER_AUTH` with no vendor text, while the *log* does carry the detail.

### 4. Client — the browser gets no secrets

```bash
grep -rlE "AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}" .next/static/ public/ 2>/dev/null
grep -rn "NEXT_PUBLIC_" src/
grep -rn "process.env" src/app/components/
```

The API key must appear in **no** built client asset. `process.env` must not be read from any file
carrying `'use client'`. Confirm `src/lib/config.ts` is only ever imported by server code.

Then load the page, run a sample, and check the network response body: it contains the extracted
record by design — that is the caller's own document coming back — but it must not contain a
credential, a file path, or a provider error string.

### 5. Repo — nothing real is committed

```bash
git check-ignore .env.local && echo "ignored (good)"
git ls-files | grep -iE "\.env($|\.)" | grep -v "\.env\.example"   # must be empty
git log --all --format=%H | head -50 | xargs -I{} git grep -lE "AIza[0-9A-Za-z_-]{30,}" {} 2>/dev/null
```

Confirm `.env.example` contains **no** filled values. Confirm every file under `public/samples/` is
reproducible from `samples/generate.sh` — a document that cannot be regenerated is a document whose
provenance is unknown, which is exactly the thing synthetic samples exist to avoid.

### 6. Regression

The invariant is only durable if a test enforces it. Confirm `tests/obs/redaction.test.ts` still runs a
real document through the pipeline, captures the log sink, and asserts the values are absent —
and that it also asserts the failure codes are still *present*.

If this command found a leak that the test suite did not, **add the case to that test** before
fixing the leak. A leak found once and not pinned by a test will return.

```bash
pnpm test
```

## Report

Report only what was verified, and state plainly what was not.

```
LEAK CHECK — <date>, provider <name>

  Static      PASS / n findings
  Runtime     PASS / n findings      <k> values searched across <m> log lines
  Health      PASS / n findings
  Client      PASS / n findings
  Repo        PASS / n findings

FINDINGS
  <severity>  <file:line or endpoint>  <what leaked, and how it was observed>

NOT CHECKED
  <anything skipped, and why — an unrun phase is not a pass>
```

Severity: **critical** for a field value, credential, or document byte escaping; **high** for a
provider message or path reaching the client; **medium** for a weakened compile-time guarantee such
as `LogValue` widening; **low** for reduced debuggability.

Do not report a phase as passing if it was not run. Do not soften a finding because the value looked
harmless — a synthetic licence number leaking proves a real one would.
