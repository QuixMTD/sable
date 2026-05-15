"""AST gate. Runs BEFORE a single line executes. Rejects:

  * imports whose top-level module isn't on the allowlist
  * calls to eval / exec / compile / open / __import__ / getattr / ...
  * any access to a dunder attribute (`x.__class__`, `.__globals__`,
    `.__subclasses__`, `.__bases__`, `.__mro__`, `.__builtins__`, …) —
    this is the single highest-value rule; nearly every sandbox escape
    goes through dunder attribute walking.

A pass here does NOT mean the code is safe — it means it's safe enough
to hand to the OS jail. The jail (subprocess, rlimits, no network,
non-root, read-only fs) is the real containment.
"""

from __future__ import annotations

import ast

from app.sandbox.allowlist import ALLOWED_IMPORTS, DENIED_CALL_NAMES

# A few attribute names that aren't dunders but are pure escape vectors.
DENIED_ATTRS: frozenset[str] = frozenset(
    {
        "f_globals",
        "f_locals",
        "f_builtins",
        "gi_frame",
        "cr_frame",
        "ag_frame",
        "f_back",
    }
)


class ValidationError(ValueError):
    """Raised when user code fails the gate. Message is client-safe."""


def validate(code: str) -> None:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise ValidationError(f"syntax error: {e.msg} (line {e.lineno})") from e

    for node in ast.walk(tree):
        # ---- imports -----------------------------------------------------
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in ALLOWED_IMPORTS:
                    raise ValidationError(f"import of '{top}' is not permitted")
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if node.level and node.level > 0:
                raise ValidationError("relative imports are not permitted")
            if top not in ALLOWED_IMPORTS:
                raise ValidationError(f"import from '{top}' is not permitted")

        # ---- dangerous calls --------------------------------------------
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in DENIED_CALL_NAMES:
                raise ValidationError(f"call to '{func.id}()' is not permitted")

        # ---- attribute escapes ------------------------------------------
        elif isinstance(node, ast.Attribute):
            attr = node.attr
            if attr.startswith("__") and attr.endswith("__"):
                raise ValidationError(f"access to dunder attribute '{attr}' is not permitted")
            if attr in DENIED_ATTRS:
                raise ValidationError(f"access to attribute '{attr}' is not permitted")

        # ---- with-as / global / nonlocal noise we don't need ------------
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            # Harmless inside the sandbox, but disallow to keep the
            # exec namespace analysis simple.
            raise ValidationError("global / nonlocal declarations are not permitted")
