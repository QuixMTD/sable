import ast

FORBIDDEN = {
    "os",
    "subprocess",
    "socket",
    "sys",
    "shutil",
    "importlib",
    "ctypes",
    "builtins",
    "threading",
    "multiprocessing",
    "asyncio",
    "pathlib",
}


class ValidationError(ValueError):
    pass


def validate(code: str) -> None:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise ValidationError(f"syntax error: {e.msg}") from e

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mod = alias.name.split(".")[0]
                if mod in FORBIDDEN:
                    raise ValidationError(f"'{mod}' is not permitted")
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if mod in FORBIDDEN:
                raise ValidationError(f"'{mod}' is not permitted")
