#!/usr/bin/env bash
#
# unattended-digest.sh — show what happened during an unattended run.
#
# Unattended state and artifacts are per session:
#   <project>/.opencode/unattended/sessions/<session-id>/decisions.jsonl
#   <project>/.opencode/unattended/sessions/<session-id>/SUMMARY.md
#
# The legacy project-wide layout is still readable when no session directory
# exists:
#   <project>/.opencode/unattended/decisions.jsonl
#   <project>/.opencode/unattended/SUMMARY.md
#
# Prints two sections:
#   ## FYI (autonomous decisions)      -- every line with escalate != true
#   ## ⚠️ Action needed               -- every line with "escalate": true
#
# Usage:
#   unattended-digest.sh [--session <id>] [project-dir]
#
# With no --session:
#   * one session directory  -> use it
#   * several                -> list them and exit 2
#   * none                   -> read the legacy project-wide files
#
# NOTE: Notification is intentionally a no-op for now. To push this digest
# somewhere, implement notify() below (an ntfy example is provided).
#
set -euo pipefail

SESSION=""
PROJECT=""

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      SESSION="${2:-}"
      shift 2
      ;;
    --session=*)
      SESSION="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PROJECT="$1"
      shift
      ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  PROJECT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

SESSIONS_ROOT="$PROJECT/.opencode/unattended/sessions"

if [[ -n "$SESSION" ]]; then
  # Match the plugin's sanitization.
  SESSION="$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')"
  DIR="$SESSIONS_ROOT/$SESSION"
elif [[ -d "$SESSIONS_ROOT" ]]; then
  mapfile -t SESSION_DIRS < <(find "$SESSIONS_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)
  count="${#SESSION_DIRS[@]}"
  if [[ "$count" -eq 1 ]]; then
    DIR="${SESSION_DIRS[0]}"
    SESSION="$(basename "$DIR")"
  elif [[ "$count" -eq 0 ]]; then
    DIR="$PROJECT/.opencode/unattended"
  else
    echo "Multiple unattended sessions in $SESSIONS_ROOT:" >&2
    for d in "${SESSION_DIRS[@]}"; do echo "  $(basename "$d")" >&2; done
    echo "Pick one with --session <id>." >&2
    exit 2
  fi
else
  DIR="$PROJECT/.opencode/unattended"
fi

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
if [[ -n "$SESSION" ]]; then
  digest+="Session: $SESSION"$'\n'
fi
digest+="State:   $DIR"$'\n'

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
