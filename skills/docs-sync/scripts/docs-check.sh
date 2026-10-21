#!/usr/bin/env bash
# docs-check.sh — generic, read-only documentation consistency check.
#
# Two checks that work in any repository:
#   1. every relative markdown link in an in-scope doc resolves
#   2. every backticked token that looks like a repo path resolves (against the
#      repo root or the doc's own directory), or is intentionally gitignored
#
# Read-only. Prints one line per finding and a summary:
#   MISS:  definitely wrong, must be fixed
#   WARN:  probably fine, verify
#   OK:    summary line
# Exit 0 when clean, 1 when any MISS is printed, 2 on usage/setup error.
#
# In-scope docs: the --docs globs, or the `check.docs` (or `docs`) globs from the
# project's .opencode/docs-sync.json, or by default every *.md outside skip
# dirs. Glob rules follow OpenCode's permission matcher: * and ** match any run
# of characters including '/', ? matches exactly one.

set -u

declare -a DOCS_GLOBS=() SKIP_DIRS=("docs/superpowers/" "node_modules/" ".git/")
root=""

while [ $# -gt 0 ]; do
  arg="$1"; shift
  case "$arg" in
    --root=*) root="${arg#--root=}" ;;
    --root) if [ $# -gt 0 ]; then root="$1"; shift; else echo "docs-check: --root needs a value" >&2; exit 2; fi ;;
    --docs=*) DOCS_GLOBS+=("${arg#--docs=}") ;;
    --docs) [ $# -gt 0 ] || { echo "docs-check: --docs needs a value" >&2; exit 2; }
      DOCS_GLOBS+=("$1"); shift ;;
    --skip=*) SKIP_DIRS+=("${arg#--skip=}") ;;
    --skip) [ $# -gt 0 ] || { echo "docs-check: --skip needs a value" >&2; exit 2; }
      SKIP_DIRS+=("$1"); shift ;;
    --help|-h)
      echo "usage: docs-check.sh [--root DIR] [--docs GLOB]... [--skip DIR]..."
      exit 0 ;;
    *) echo "docs-check: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$root" ]; then
  root="$PWD"
elif [ ! -d "$root" ]; then
  echo "docs-check: root not found: $root" >&2
  exit 2
fi
root="$(cd "$root" && pwd)"

config="$root/.opencode/docs-sync.json"
failed_config=0
if [ -f "$config" ] && command -v python3 >/dev/null 2>&1; then
  # Use the config's scope only where the caller gave no explicit override.
  if [ "${#DOCS_GLOBS[@]}" -eq 0 ]; then
    while IFS= read -r g; do
      [ -n "$g" ] && DOCS_GLOBS+=("$g")
    done < <(python3 -c '
import json,sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit()
d = (c.get("check") or {}).get("docs") or c.get("docs") or []
print("\n".join(x for x in d if isinstance(x, str)))' "$config" 2>/dev/null)
  fi
  while IFS= read -r s; do
    [ -n "$s" ] && SKIP_DIRS+=("$s")
  done < <(python3 -c '
import json,sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit()
d = (c.get("check") or {}).get("skipDirs") or []
print("\n".join(x for x in d if isinstance(x, str)))' "$config" 2>/dev/null)
elif [ -f "$config" ]; then
  failed_config=1
fi

# --- helpers ---------------------------------------------------------------

# glob -> regex matching the strings OpenCode's permission matcher accepts.
glob_re() {
  local g="$1" out="" i c
  for ((i = 0; i < ${#g}; i++)); do
    c="${g:i:1}"
    case "$c" in
      '*') out="$out.*" ;;
      '?') out="$out." ;;
      '.'|'+'|'('|')'|'|'|'^'|'$'|'{'|'}'|'['|']'|'\') out="$out\\$c" ;;
      *) out="$out$c" ;;
    esac
  done
  printf '^%s$' "$out"
}

is_skipped() { # $1 = repo-relative path
  local rel="$1" g
  case "$rel" in /*) rel="${rel#/}" ;; esac
  for g in "${SKIP_DIRS[@]}"; do
    [ -n "$g" ] || continue
    g="${g%/}"
    [ -n "$g" ] || continue
    case "$rel/" in "$g"/*) return 0 ;; esac
  done
  return 1
}

matches_any() { # $1 = repo-relative path, $2.. = globs
  local rel="$1"; shift
  local pat re
  for pat in "$@"; do
    [ -n "$pat" ] || continue
    re="$(glob_re "$pat")"
    if printf '%s' "$rel" | grep -Eq "$re"; then return 0; fi
  done
  return 1
}

gitignored() {
  git -C "$root" check-ignore -q -- "$1" 2>/dev/null
}

# --- collect in-scope docs -------------------------------------------------
declare -a in_scope=()
while IFS= read -r -d '' abs; do
  rel="${abs#"$root"/}"
  [ -n "$rel" ] && [ "$rel" != "$abs" ] || continue
  is_skipped "$rel" && continue
  gitignored "$rel" && continue
  if [ "${#DOCS_GLOBS[@]}" -gt 0 ] && ! matches_any "$rel" "${DOCS_GLOBS[@]}"; then
    continue
  fi
  in_scope+=("$rel")
done < <(find "$root" -name '*.md' -type f \
  -path "$root/*" -not -path "$root/node_modules/*" \
  -not -path "$root/.git/*" -print0 2>/dev/null)

if [ "${#in_scope[@]}" -eq 0 ]; then
  echo "docs-check: no in-scope markdown found under $root" >&2
  exit 2
fi

miss=0
warn=0

# --- Check 1: markdown links ----------------------------------------------
for doc in "${in_scope[@]}"; do
  doc_dir="$(dirname "$root/$doc")"
  while IFS= read -r target; do
    case "$target" in
      http://*) continue ;;
      https://*) continue ;;
      mailto:*) continue ;;
      "#"*) continue ;;
      "") continue ;;
      "<"*">") target="${target#<}"; target="${target%>}" ;;
    esac
    clean="${target%%#*}"
    clean="${clean%%\?*}"
    [ -z "$clean" ] && continue
    if [ -e "$doc_dir/$clean" ]; then continue; fi
    if gitignored "$doc_dir/$clean"; then continue; fi
    # Targets inside skipped doc trees (historical, vendor-only) are unresolvable
    # by design and say nothing about this doc.
    target_in_doc_dir="$doc_dir/$clean"
    if is_skipped "${target_in_doc_dir#"$root"/}"; then continue; fi
    printf 'MISS: %s: broken link -> %s\n' "$doc" "$target"
    miss=$((miss + 1))
  done < <(grep -ohE '\]\([^)]+\)' "$root/$doc" 2>/dev/null | sed -E 's/^\]\(//; s/\)$//')
done

# --- Check 2: backticked path tokens ---------------------------------------
for doc in "${in_scope[@]}"; do
  doc_dir="$(dirname "$root/$doc")"
  while IFS= read -r token; do
    case "$token" in
      *'*'*|*'{'*|*'}'*|*'$'*|*'<'*|*'>'*|*'('*|*')'*|*','*|*':') continue ;;
      '*'|'"'*|"'"*) continue ;;
    esac
    case "$token" in
      *.md|*.py|*.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.yaml|*.yml|*.sh|*.toml|\
*.service|*.env|*.sql|*.rb|*.go|*.rs|*.java|*.jsonl|*/|*/Dockerfile|\
*/Dockerfile.*|*/Makefile|*/Procfile) : ;;
      *) continue ;;
    esac
    case "$token" in /*) continue ;; esac
    if [ -e "$root/$token" ]; then continue; fi
    if [ -e "$doc_dir/$token" ]; then continue; fi
    if gitignored "$root/$token" || gitignored "$doc_dir/$token"; then continue; fi
    printf 'WARN: %s: path not found -> %s\n' "$doc" "$token"
    warn=$((warn + 1))
  done < <(grep -ohE '`[^`]{1,200}`' "$root/$doc" 2>/dev/null | sed -E 's/^`//; s/`$//')
done

echo "OK    ${#in_scope[@]} docs checked, $miss MISS, $warn WARN"
[ "$failed_config" -eq 1 ] && echo "WARN: could not parse $config (no python3); scope defaults used"
[ "$miss" -gt 0 ] && exit 1
exit 0
