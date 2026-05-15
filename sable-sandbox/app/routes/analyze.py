"""POST /analyze — static, no execution.

sable-engine calls this BEFORE fetching anything: it returns the
security verdict, the `@requires`/`@client`/`@portfolio` header the
user declared (Option 1), and the `data['<key>']` subscripts the
script actually reads (Option 2), plus the imports. One round-trip,
zero execution risk — nothing is run, so there are no limits and no
injected data on this request.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.http import success

from app.sandbox.analyze import analyze

router = APIRouter()

_MAX_CODE_CHARS = 100_000


class AnalyzeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=_MAX_CODE_CHARS)


@router.post("/analyze")
def analyze_route(req: AnalyzeRequest) -> dict[str, object]:
    return success(analyze(req.code))
