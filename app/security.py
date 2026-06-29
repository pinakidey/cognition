import logging

from fastapi import HTTPException, Request

from app.config import settings

logger = logging.getLogger(__name__)


async def verify_admin_key(request: Request) -> None:
    """FastAPI dependency that checks for a valid admin API key on protected endpoints.

    If ADMIN_API_KEY is not configured, access is unrestricted (backwards-compatible).
    Accepts the key via `X-Admin-Key` header or `Authorization: Bearer <key>`.
    """
    if not settings.admin_api_key:
        return

    token = request.headers.get("x-admin-key") or ""
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:].strip()

    if not token or token != settings.admin_api_key:
        client_ip = request.client.host if request.client else "unknown"
        logger.warning("Unauthorized admin access attempt from %s to %s", client_ip, request.url.path)
        raise HTTPException(status_code=401, detail="Unauthorized")
