import httpx
import logging

from config import settings

logger = logging.getLogger(__name__)

HEADERS = {
    "Authorization": f"Bearer {settings.devin_api_key}",
    "Content-Type": "application/json",
}


async def create_session(prompt: str, tags: list[str] | None = None) -> dict:
    """Create a new Devin session via the API."""
    payload: dict = {
        "prompt": prompt,
        "max_acu_limit": settings.devin_max_acu,
    }
    if tags:
        payload["tags"] = tags

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{settings.devin_api_base}/sessions",
            headers=HEADERS,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        logger.info("Created Devin session: %s", data.get("session_id"))
        return data


async def get_session(session_id: str) -> dict:
    """Get session details including status."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{settings.devin_api_base}/sessions/{session_id}",
            headers=HEADERS,
        )
        response.raise_for_status()
        return response.json()
