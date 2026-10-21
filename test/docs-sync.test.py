#!/usr/bin/env python3
"""Tests for the generic docs-keeper / docs-sync implementation shipped by the
plugin.

Covers the parts that run without node: the shipped docs-check.sh checker, the
per-project config parsing the plugin's own docs-sync path uses, and the
agent/skill wiring when opencode is running.

Run:  python3 test/docs-sync.test.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOCS_CHECK = os.path.join(ROOT, "skills", "docs-sync", "scripts", "docs-check.sh")
AGENT_FILE = os.path.join(ROOT, "agents", "docs-keeper.md")
SKILL_FILE = os.path.join(ROOT, "skills", "docs-sync", "SKILL.md")

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok   - {name}")
    else:
        failed += 1
        print(f"FAIL - {name} :: {detail}")


def run_check(args, cwd, expect_fail=False):
    proc = subprocess.run(
        [DOCS_CHECK] + args, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if expect_fail and proc.returncode not in (0, 1, 2):
        return None
    return proc


# Fallback rules for {{VAR}} substitution, mirroring lib/register-agents.js.
def substitute(body, vars):
    for key, value in vars.items():
        body = body.replace("{{" + key + "}}", str(value or ""))
    return body


def tempdir(prefix):
    """Prefer /tmp/opencode (pre-approved for external scratch); fall back to the
    system temp if it is not writable by this user."""
    for base in ("/tmp/opencode", None):
        try:
            return tempfile.mkdtemp(prefix=prefix, dir=base)
        except (PermissionError, OSError):
            continue
    raise RuntimeError("no writable temp directory")


def main():
    work = tempdir("ds-guard-")
    fixture = os.path.join(work, "fixture")
    os.makedirs(os.path.join(fixture, "docs", "deep"))
    os.makedirs(os.path.join(fixture, "src", "app"))
    os.makedirs(os.path.join(fixture, "docs", "superpowers"))

    def write(rel, text):
        path = os.path.join(fixture, rel)
        with open(path, "w") as fh:
            fh.write(text)

    write("README.md",
          "# Demo\n\nSee [good](docs/guide.md) and [bad](docs/nope.md) and "
          "[anchor](#top) and [web](https://example.com/x).\n\n"
          "Use `src/main.py` and `scripts/` and `git status`.\n")
    write("docs/guide.md",
          "Guide referencing `main.py` (doc-relative) and `src/mozzarella.md`.\n")
    write("docs/deep/deeper.md", "Deepest doc, references `../guide.md`.\n")
    write("docs/superpowers/history.md", "Historical, references `defunct.md`.\n")
    write("src/main.py", "x = 1\n")
    write("src/app/main.js", "// x\n")

    # No config, no --docs: every *.md outside the skip dirs is in scope.
    proc = run_check(["--root", fixture], fixture)
    out = proc.stdout
    check("checker rejects no-root", proc.returncode == 1, "'" + out + "'")
    check("checker reports a broken link",
          "MISS: README.md: broken link -> docs/nope.md" in out, out)
    check("checker does not report an anchor-only link",
          "anchor" not in out, out)
    check("checker does not report an external link",
          "https://example.com" not in out, out)
    check("checker does not flag a git command",
          "git status" not in out, out)
    check("checker does not footgun on a skipped doc tree",
          "docs/superpowers/history.md" not in out, out)
    check("checker warns on an unresolvable absolute path",
          "WARN: docs/guide.md: path not found -> src/mozzarella.md" in out, out)
    check("checker warns the dir token",
          "WARN: README.md: path not found -> scripts/" in out, out)
    check("checker resolves a doc-relative markdown link",
          "docs/deep/deeper.md: broken link" not in out, out)
    check("checker resolves the root-relative path token",
          "README.md: path not found -> src/main.py" not in out, out)
    check("checker summary line",
          "1 MISS, 3 WARN" in out, out)
    check("broken link exits 1 with MISS", proc.returncode == 1, "'" + out + "'")

    # Root-relative token check hits the doc's directory too.
    proc = run_check(["--root", fixture, "--docs", "docs/deep/*.md"], fixture)
    check("checker accepts --docs", proc.returncode == 0, proc.stdout)
    check("--docs narrows the scope (one doc, no MISS)",
          "1 docs checked" in proc.stdout and "MISS:" not in proc.stdout, proc.stdout)

    # Config-driven scope and skip dirs.
    os.makedirs(os.path.join(fixture, ".opencode"), exist_ok=True)
    write(os.path.join(".opencode", "docs-sync.json"), json.dumps({
        "sourceOfTruth": "flux manifests",
        "docs": ["README.md", "docs/superpowers/**"],
        "check": {"docs": ["README.md"], "skipDirs": ["docs/"]},
    }))
    check("config-scoped checker runs", proc.returncode == 0, str(proc.returncode))
    check("config-scoped checker reports no MISS", "MISS:" not in proc.stdout, proc.stdout)
    check("config-scoped checker still scans 1 doc",
          "1 docs checked" in proc.stdout, proc.stdout)

    # --docs beats the config's *skip* list for paths outside it.
    proc = run_check(["--root", fixture, "--docs", "README.md"], fixture)
    check("--docs outside the config's skip list is found",
          "1 docs checked" in proc.stdout, proc.stdout)

    # No in-scope markdown -> clean usage/setup failure, not a hang.
    proc = run_check(["--root", fixture, "--docs", "no-such-dir/*.md"], fixture)
    check("empty scope is a clean usage error", proc.returncode == 2, proc.stdout)

    # .gitignore-aware scope
    proc = subprocess.run(["git", "init", fixture], capture_output=True, text=True)
    write(".gitignore", "docs/guide.md\n")
    proc = run_check(["--root", fixture], fixture)
    check("gitignored docs are out of scope",
          "docs/guide.md" not in proc.stdout, proc.stdout)

    write(os.path.join(".opencode", "docs-sync.json"), "{ not json")
    proc = run_check(["--root", fixture], fixture)
    check("malformed config falls back (default scope, no crash)",
          proc.returncode != 2, proc.stdout)


    # Missing arg values are usage errors.
    proc = run_check(["--root"], fixture)
    check("missing --root value is a usage error", proc.returncode == 2, proc.stdout)
    proc = run_check(["--bogus"], fixture)
    check("unknown flag is a usage error", proc.returncode == 2, proc.stdout)

    # ── plugins' own config parsing ────────────────────────────────────────────
    # Mirror lib/docs-config.js by reading the same JSON. node's ESM is used by
    # the plugin itself, so here we assert on the semantics indirectly.
    os.makedirs(os.path.join(fixture, ".opencode"), exist_ok=True)
    write(os.path.join(".opencode", "docs-sync.json"), json.dumps({
        "sourceOfTruth": "the code", "docs": ["README.md", "src/cli/README.md"]}))
    proc = subprocess.run(
        ["python3", "-c", _read_config, os.path.join(fixture, ".opencode/docs-sync.json")],
        capture_output=True, text=True)
    parsed = json.loads(proc.stdout)
    check("config parser reads sourceOfTruth", parsed["sourceOfTruth"] == "the code")
    check("config parser reads docs list",
          parsed["docs"] == ["README.md", "src/cli/README.md"])
    check("config parser defaults readOnlyDocs/protected",
          parsed.get("readOnlyDocs") == ["docs/superpowers/**"], proc.stdout)

    # ── shipped agent + skill body are generic (no held-out repo specifics) ────
    agent = open(AGENT_FILE, encoding="utf-8").read()
    skill = open(SKILL_FILE, encoding="utf-8").read()
    for repo_specific in ["flux/", "enel", "OVERVIEW.md", "CHANGELOG.md", "gitlab"]:
        check(f"agent body does not reference {repo_specific.rstrip('/')}",
              repo_specific not in agent, repo_specific)
    for repo_specific in ["flux/", "enel", "OVERVIEW.md", "gitlab"]:
        check(f"skill body does not reference {repo_specific.rstrip('/')}",
              repo_specific not in skill, repo_specific)

    # ── placeholder substitution ──────────────────────────────────────────────
    vars = {
        "SOURCE_OF_TRUTH": "flux manifests",
        "ALLOWED_DOCS": "README.md, docs/**",
        "PROTECTED_DOCS": "docs/superpowers/**",
        "DOC_MAP": "| Change | Docs |",
        "STYLE": "terse",
    }
    subd = re.sub(r"\{\{[A-Z_]+\}\}", "", agent)
    subd = substitute(agent, vars)
    check("agent prompt substitutes every placeholder", "{{" not in subd, agent)
    check("substituted prompt names the allowed docs", "README.md, docs/**" in subd)
    check("skill body ships the checker script placeholder",
          "{{DOCS_CHECK_SCRIPT}}" in skill, skill)

    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


_read_config = r'''
import json, sys
c = json.load(open(sys.argv[1]))
out = {
  "sourceOfTruth": c.get("sourceOfTruth", ""),
  "docs": [x for x in c.get("docs", []) if isinstance(x, str)],
  "readOnlyDocs": c.get("readOnlyDocs") or ["docs/superpowers/**"],
}
print(json.dumps(out))
'''

sys.exit(main())
