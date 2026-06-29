import asyncio
import httpx
import logging

from app.config import settings

logger = logging.getLogger(__name__)

HEADERS = {
    "Authorization": f"Bearer {settings.devin_api_key}",
    "Content-Type": "application/json",
}


async def create_session(prompt: str, tags: list[str] | None = None) -> dict:
    """Create a new Devin session via the API with exponential backoff retry."""
    payload: dict = {
        "prompt": prompt,
        "max_acu_limit": settings.devin_max_acu,
    }
    if tags:
        payload["tags"] = tags

    last_error: Exception | None = None
    for attempt in range(1, settings.max_retry_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    f"{settings.devin_api_base}/sessions",
                    headers=HEADERS,
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()
                logger.info("Created Devin session: %s (attempt %d)", data.get("session_id"), attempt)
                return data
        except (httpx.HTTPStatusError, httpx.RequestError) as e:
            last_error = e
            if attempt < settings.max_retry_attempts:
                delay = settings.retry_base_delay_seconds * (2 ** (attempt - 1))
                logger.warning(
                    "Devin API request failed (attempt %d/%d), retrying in %ds: %s",
                    attempt, settings.max_retry_attempts, delay, str(e),
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "Devin API request failed after %d attempts: %s",
                    settings.max_retry_attempts, str(e),
                )

    raise last_error  # type: ignore[misc]


async def get_session(session_id: str) -> dict:
    """Get session details including status."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{settings.devin_api_base}/sessions/{session_id}",
            headers=HEADERS,
        )
        response.raise_for_status()
        return response.json()
