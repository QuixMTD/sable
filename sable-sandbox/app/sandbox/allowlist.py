"""What user code is allowed to touch.

The real security boundary is OS-level isolation (subprocess + rlimits
+ no network + non-root + read-only rootfs). This allowlist is the
*first* wall — it makes the obvious escapes fail at parse time so they
never reach the jail at all.

Import policy is an allowlist (deny by default). Builtin policy is a
small denylist of the names that turn "run some pandas" into "pop a
shell" — `__import__` is intentionally KEPT because the import statement
needs it; the AST gate is what constrains *which* modules import can
reach.
"""

from __future__ import annotations

# Top-level modules user code may import. Submodules of these are fine
# (`from scipy import stats`, `import numpy.linalg`) because the gate
# checks the first dotted segment.
ALLOWED_IMPORTS: frozenset[str] = frozenset(
    {
        # Analytics stack — the whole point of Tier-3 scripts
        "numpy",
        "pandas",
        "scipy",
        "matplotlib",
        "statsmodels",
        "sklearn",
        # Quant-finance stack. NOTE: import name != pip name for
        # PyPortfolioOpt (imports as `pypfopt`).
        "cvxpy",
        "pypfopt",
        "arch",
        "empyrical",
        "sympy",
        "seaborn",
        # Safe stdlib
        "math",
        "statistics",
        "json",
        "datetime",
        "random",
        "itertools",
        "functools",
        "collections",
        "decimal",
        "fractions",
        "typing",
        "dataclasses",
        "re",
        "string",
        "textwrap",
        "heapq",
        "bisect",
        "enum",
        "abc",
        "warnings",
    }
)

# Builtins removed from the exec namespace. The import system still works
# (we keep __import__) but file/eval/introspection primitives are gone.
DENIED_BUILTINS: frozenset[str] = frozenset(
    {
        "open",
        "eval",
        "exec",
        "compile",
        "input",
        "breakpoint",
        "help",
        "exit",
        "quit",
        "globals",
        "locals",
        "vars",
        "memoryview",
    }
)

# Call targets blocked at parse time (name-based; cheap and high-signal).
DENIED_CALL_NAMES: frozenset[str] = frozenset(
    {
        "eval",
        "exec",
        "compile",
        "open",
        "__import__",
        "input",
        "breakpoint",
        "globals",
        "locals",
        "vars",
        "getattr",   # blocks getattr(obj, "__class__") style escapes
        "setattr",
        "delattr",
    }
)


def safe_builtins() -> dict[str, object]:
    """A copy of builtins with the denied names stripped."""
    import builtins as _b

    out: dict[str, object] = {}
    for name in dir(_b):
        if name in DENIED_BUILTINS:
            continue
        out[name] = getattr(_b, name)
    return out
