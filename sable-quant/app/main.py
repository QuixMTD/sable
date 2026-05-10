from fastapi import FastAPI

from app.routers import black_litterman, montecarlo

app = FastAPI(title="sable-quant", version="0.1.0")

app.include_router(montecarlo.router)
app.include_router(black_litterman.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
