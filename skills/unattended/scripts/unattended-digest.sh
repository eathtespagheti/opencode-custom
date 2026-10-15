#!/usr/bin/env bash
#
# unattended-digest.sh — show what happened during an unattended run.
#
# Reads:
#   <project>/.opencode/unattended/decisions.jsonl   (one JSON object per line)
#   <project>/.opencode/unattended/SUMMARY.md
#
# Prints two sections:
#   ## FYI (autonomous decisions)      -- every line with escalate != true
#   ## ⚠️ Action needed               -- every line with "escalate": true
#
# Usage:
#   unattended-digest.sh [project-dir]      # default: git root, else $PWD
#
# NOTE: Notification is intentionally a no-op for now. To push this digest
# somewhere, implement notify() below (an ntfy example is provided). A systemd
# user timer intended to run this at ~07:00 is deliberately NOT installed yet,
# because with no channel it would deliver nothing.
#
set -euo pipefail

PROJECT="${1:-}"
if [[ -z "$PROJECT" ]]; then
  PROJECT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

DIR="$PROJECT/.opencode/unattended"
JSONL="$DIR/decisions.jsonl"
SUMMARY="$DIR/SUMMARY.md"

# ── Notification hook (no-op for now) ────────────────────────────────────────
# Implement this to push "$1" (the digest body) to a channel. Example (ntfy):
#   curl -fsS -d "$1" "https://ntfy.sh/${NTFY_TOPIC:-CHANGE_ME}" >/dev/null || true
notify() {
  : # no channel configured; digest is printed to stdout instead
}

# ── Render one JSON line as a readable bullet ────────────────────────────────
render_jq() {
  jq -r '
    def brief: if .question then .question else (.event // .task // "decision") end;
    "- [\(.ts // "?")] \(.task // "task") — \(brief)"
    + (if .chosen     then " → \(.chosen)"                else "" end)
    + (if .rationale  then " (\(.rationale))"             else "" end)
    + (if .confidence != null then " [confidence \(.confidence)]" else "" end)
    + (if .reversible != null then " [reversible=\(.reversible)]" else "" end)
  '
}

# Fallback for hosts without jq.
render_py() {
  python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    brief = d.get("question") or d.get("event") or d.get("task") or "decision"
    out = "- [{}] {} — {}".format(d.get("ts", "?"), d.get("task", "task"), brief)
    if d.get("chosen"):    out += " → {}".format(d["chosen"])
    if d.get("rationale"): out += " ({})".format(d["rationale"])
    if d.get("confidence") is not None: out += " [confidence {}]".format(d["confidence"])
    if d.get("reversible") is not None: out += " [reversible={}]".format(d["reversible"])
    print(out)
'
}

render() {
  if command -v jq >/dev/null 2>&1; then
    render_jq
  elif command -v python3 >/dev/null 2>&1; then
    render_py
  else
    cat
  fi
}

# ── Build the digest ─────────────────────────────────────────────────────────
digest=""
digest+="# Unattended run digest"$'\n'
digest+="Project: $PROJECT"$'\n'

if [[ -f "$JSONL" ]]; then
  fyi="$(grep -v '"escalate":true' "$JSONL" | grep -v '"escalate": true' | render || true)"
  action="$(grep -E '"escalate":\s*true' "$JSONL" | render || true)"

  digest+=$'\n'"## FYI (autonomous decisions)"$'\n'
  if [[ -n "$fyi" ]]; then digest+="$fyi"$'\n'; else digest+="_none_"$'\n'; fi

  digest+=$'\n'"## ⚠️ Action needed"$'\n'
  if [[ -n "$action" ]]; then digest+="$action"$'\n'; else digest+="_none_"$'\n'; fi
else
  digest+=$'\n'"_No decisions log yet ($JSONL not found)._"$'\n'
fi

if [[ -f "$SUMMARY" ]]; then
  digest+=$'\n'"## Summary"$'\n'
  digest+="$(cat "$SUMMARY")"$'\n'
else
  digest+=$'\n'"_No SUMMARY.md yet ($SUMMARY not found)._"$'\n'
fi

printf '%s' "$digest"
notify "$digest"
