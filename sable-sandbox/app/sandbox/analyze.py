"""Static analysis for sable-engine's pre-fetch step. NO execution.

Two things sable-engine needs before it runs a Tier-3 script:

  Option 1 — explicit `@requires` / `@client` / `@portfolio` header
             comments the user wrote.
  Option 2 — automatic detection: which `data['<key>']` subscripts the
             script actually reads.

`analyze()` returns both, plus the imports and the security-gate
verdict, so the engine gets everything from one call before fetching a
single byte from the modules.
"""

from __future__ import annotations

import ast
import re

from app.sandbox.validate import ValidationError, validate

_REQUIRES_RE = re.compile(r"#\s*@requires\s+(.+)")
_CLIENT_RE = re.compile(r"#\s*@client\s+(\S+)")
_PORTFOLIO_RE = re.compile(r"#\s*@portfolio\s+(\S+)")


def _parse_header(code: str) -> dict[str, object]:
    requires: list[str] = []
    client: str | None = None
    portfolio: str | None = None
    for line in code.splitlines():
        stripped = line.strip()
        if not stripped.startswith("#"):
            # Headers must live in the leading comment block; stop at the
            # first real statement so a `# @requires` inside a docstring
            # or later comment can't smuggle requirements.
            if stripped:
                break
            continue
        m = _REQUIRES_RE.search(stripped)
        if m:
            requires.extend(tok.strip() for tok in re.split(r"[,\s]+", m.group(1)) if tok.strip())
        m = _CLIENT_RE.search(stripped)
        if m:
            client = m.group(1)
        m = _PORTFOLIO_RE.search(stripped)
        if m:
            portfolio = m.group(1)
    return {"requires": requires, "client": client, "portfolio": portfolio}


def _data_keys(tree: ast.AST) -> list[str]:
    keys: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == "data"
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            keys.add(node.slice.value)
    return sorted(keys)


def _imports(tree: ast.AST) -> list[str]:
    mods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mods.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            mods.add((node.module or "").split(".")[0])
    return sorted(m for m in mods if m)


def analyze(code: str) -> dict[str, object]:
    """Static report. Never raises on user code — validity is a field,
    not an exception, because the engine wants the verdict AND the keys
    in one round-trip."""
    declared = _parse_header(code)

    # Security gate verdict (does not stop key extraction below).
    valid = True
    error: str | None = None
    try:
        validate(code)
    except ValidationError as e:
        valid = False
        error = str(e)

    # Key/import extraction needs a parse tree. If the source doesn't
    # even parse, the gate already reported the syntax error.
    try:
        tree = ast.parse(code)
        data_keys = _data_keys(tree)
        imports = _imports(tree)
    except SyntaxError:
        data_keys = []
        imports = []

    return {
        "valid": valid,
        "error": error,
        "data_keys": data_keys,
        "declared": declared,
        "imports": imports,
    }
