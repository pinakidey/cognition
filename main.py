import asyncio
import logging

from contextlib import asynccontextmanager
from fastapi import FastAPI

from database import init_db
from poller import start_poller
from webhook import router as webhook_router
from dashboard import router as dashboard_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
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
