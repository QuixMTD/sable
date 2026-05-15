# Build from the REPO ROOT (context must include sable-shared-py):
#   docker build -f sable-quant/Dockerfile -t sable-quant .

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Shared lib first (changes rarely → cached layer).
COPY sable-shared-py/ /deps/sable-shared-py/
RUN pip install --no-cache-dir /deps/sable-shared-py

COPY sable-quant/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sable-quant/app/ ./app/

RUN useradd --create-home --uid 1000 sable
USER sable

ENV PORT=8080
EXPOSE 8080

# Trusted compute — no AST jail, but still HMAC-gated and non-root.
# Deploy-time: lock egress (no outbound needed), set a CPU/mem request
# matching the heaviest Monte Carlo job, scale on Cloud Run instances.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
