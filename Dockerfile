# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Runtime stage ---
FROM python:3.12-slim

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --create-home --shell /bin/bash appuser

# Copy installed packages from builder
COPY --from=builder /install /usr/local

WORKDIR /home/appuser/service

# Copy application code
COPY app/ ./app/

# Create default data directory (can be overridden via volume mount)
RUN mkdir -p /data && chown appuser:appuser /data

# Switch to non-root user
USER appuser

# All configuration via environment variables — no defaults baked in.
# Required at runtime:
#   DEVIN_API_KEY, GH_TOKEN, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID
# Optional (with sane defaults in app/config.py):
#   DB_PATH (default: ./data/jobs.db)
#   DEVIN_API_BASE, DEVIN_MAX_ACU, GITHUB_REPO, POLL_INTERVAL_SECONDS

# Expose port (configurable via PORT env var)
ENV PORT=8080
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
