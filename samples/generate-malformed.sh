#!/usr/bin/env bash
# Generate deliberately defective licences, for testing the validation rules
# against a real model rather than against fixtures.
#
#   ./samples/generate-malformed.sh
#
# These are NOT demo samples and are not served from public/ — they exist so
# `pnpm test:live` can check that each rule fires on a real model's honest
# reading of a genuinely broken page.
#
# The distinction that matters:
#
#   fault injection (src/lib/providers/decorators/fault.ts)
#       extraction is corrupted → proves the correction loop runs.
#   these documents
#       extraction is correct and the document is wrong → proves the rules are
#       right about reality, not just about the fixtures they were written with.
#
# Dates are absolute rather than relative to today, so a run in six months
# tests the same thing. `expired` and `future-issue` are chosen far enough out
# that they stay expired and stay future for years.
set -euo pipefail

cd "$(dirname "$0")/.."

out_dir="samples/malformed"
template="samples/templates/malformed.html"
mkdir -p "$out_dir"

command -v google-chrome >/dev/null 2>&1 || {
  echo "google-chrome not found — it renders the HTML specimens to PDF." >&2
  exit 1
}

activity_rows() {
  cat <<'ROWS'
<tr><td class="idx">1</td><td>Commercial Brokerage</td><td class="ar">الوساطة التجارية</td></tr>
<tr><td class="idx">2</td><td>Business Consultancy Services</td><td class="ar">خدمات استشارات الأعمال</td></tr>
ROWS
}

# id|licence|established|issue|expiry|activities(rows|none)|expected rule
variants=(
  "expiry-before-issue|661204|12/03/2018|15/01/2026|14/01/2025|rows|EXPIRY_NOT_AFTER_ISSUE"
  "future-issue|661205|12/03/2018|01/06/2031|31/05/2032|rows|ISSUE_DATE_IN_FUTURE"
  "established-after-issue|661206|01/06/2029|15/01/2026|14/01/2027|rows|ESTABLISHED_AFTER_ISSUE"
  "implausible-term|661207|12/03/2018|15/01/2026|14/01/2044|rows|TERM_IMPLAUSIBLE"
  "no-activities|661208|12/03/2018|15/01/2026|14/01/2027|none|ACTIVITIES_EMPTY"

  # A year misread as Gregorian when it was Hijri, or simply mis-keyed at the
  # issuer. Predates the UAE, so no licence can carry it.
  "issue-date-impossible|661209|12/03/1960|15/01/1965|14/01/1966|rows|ISSUE_DATE_IMPLAUSIBLE"

  # An illegible or absent licence number, which on real documents happens when
  # the seal covers it or the scan clips the header. The rule warns rather than
  # errors on purpose — a false rejection of a valid number is worse than
  # letting an odd one through to a human.
  "licence-number-illegible|N/A|12/03/2018|15/01/2026|14/01/2027|rows|LICENCE_NUMBER_MISSING"
)

manifest_entries=()

for spec in "${variants[@]}"; do
  IFS='|' read -r id licence established issue expiry activities expected <<<"$spec"

  rows=""
  [ "$activities" = "rows" ] && rows="$(activity_rows)"

  tmp="$(mktemp --suffix=.html -p samples/templates)"
  trap 'rm -f "$tmp"' EXIT

  sed -e "s|{{LICENCE_NO}}|$licence|g" \
      -e "s|{{ESTABLISHED}}|$established|g" \
      -e "s|{{ISSUE}}|$issue|g" \
      -e "s|{{EXPIRY}}|$expiry|g" \
      -e "s|{{DEFECT}}|$id|g" \
      "$template" >"$tmp"

  # Substituted separately: the rows are multi-line and would break sed's -e form.
  python3 - "$tmp" "$rows" <<'PY'
import sys, pathlib
path, rows = pathlib.Path(sys.argv[1]), sys.argv[2]
path.write_text(path.read_text().replace("{{ACTIVITIES}}", rows))
PY

  google-chrome --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$out_dir/$id.pdf" "file://$(realpath "$tmp")" >/dev/null 2>&1

  rm -f "$tmp"
  manifest_entries+=("$(printf '{"id":"%s","file":"%s.pdf","expect":"%s"}' "$id" "$id" "$expected")")
  echo "  $out_dir/$id.pdf  → expects $expected"
done

printf '[\n  %s\n]\n' "$(IFS=$',\n  '; echo "${manifest_entries[*]}")" >"$out_dir/expectations.json"
echo "Wrote $out_dir/expectations.json"
