# Build from the REPO ROOT (context must include sable-shared-py):
#   docker build -f sable-sandbox/Dockerfile -t sable-sandbox .
#
# Runtime hardening that belongs to the *platform*, not the image, is
# applied at deploy time and noted at the bottom — the jail is only as
# strong as the Cloud Run / k8s sandbox config around it.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 1. Shared lib first (changes rarely → cached layer).
COPY sable-shared-py/ /deps/sable-shared-py/
RUN pip install --no-cache-dir /deps/sable-shared-py

# 2. Service deps.
COPY sable-sandbox/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 3. Service code.
COPY sable-sandbox/app/ ./app/

# Non-root. /tmp is a writable tmpfs at runtime (see deploy notes); the
# image rootfs itself is mounted read-only.
RUN useradd --create-home --uid 1000 sable
USER sable

ENV PORT=8080
EXPOSE 8080

# ---------------------------------------------------------------------------
# Deploy-time hardening (NOT expressible in the Dockerfile — enforce on
# the Cloud Run service / k8s pod spec):
#   * read-only root filesystem; /tmp mounted as a size-capped tmpfs
#   * NO egress: lock the VPC connector / serverless-egress to deny-all
#     (the AST gate + import allowlist are belt; this is braces)
#   * drop ALL Linux capabilities; no-new-privileges
#   * pid limit on the container (fork-bomb backstop alongside RLIMIT_NPROC)
#   * memory limit >= requested mem_mb + headroom (RLIMIT_AS is the inner cap)
#   * concurrency low (e.g. 8) so N concurrent jobs can't exhaust the box
# ---------------------------------------------------------------------------

# Single worker: every /execute spawns its own short-lived child, so
# uvicorn concurrency is about request handling, not CPU. Scale with
# Cloud Run instances, not in-process workers.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
