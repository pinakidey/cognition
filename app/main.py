import asyncio
import logging

from contextlib import asynccontextmanager
from fastapi import FastAPI

from app.database import close_db, init_db
from app.poller import start_poller
from app.webhook import router as webhook_router
from app.dashboard import router as dashboard_router

class SensitiveDataFilter(logging.Filter):
    """Redact potential secrets from log messages."""

    _REDACT_PATTERNS = (
        ("Bearer ", "Bearer [REDACTED]"),
        ("token ", "token [REDACTED]"),
        ("xoxb-", "xoxb-[REDACTED]"),
        ("ghp_", "ghp_[REDACTED]"),
        ("github_pat_", "github_pat_[REDACTED]"),
        ("apk_", "apk_[REDACTED]"),
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for pattern, replacement in self._REDACT_PATTERNS:
            if pattern in msg:
                record.msg = str(record.msg).replace(pattern, replacement)
                record.args = None
        return True


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
# Apply filter to all handlers
for handler in logging.root.handlers:
    handler.addFilter(SensitiveDataFilter())

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — init DB and start background poller."""
    logger.info("Starting Devin Remediation Service")
    await init_db()

    # Start background poller
    poller_task = asyncio.create_task(start_poller())

    yield

    # Cleanup
    poller_task.cancel()
    try:
        await poller_task
    except asyncio.CancelledError:
        pass
    await close_db()
    logger.info("Shutting down Devin Remediation Service")


app = FastAPI(
    title="Devin Remediation Service",
    description="Event-driven issue remediation using Devin API",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(webhook_router)
app.include_router(dashboard_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "devin-remediation-service"}
