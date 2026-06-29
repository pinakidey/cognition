import logging
import time
from collections import defaultdict

from fastapi import Request
from fastapi.responses import JSONResponse

from app.config import settings

logger = logging.getLogger(__name__)

# Simple in-memory sliding window rate limiter (no external deps needed at this scale)
_request_counts: dict[str, list[float]] = defaultdict(list)


def _parse_rate_limit(rate_str: str) -> tuple[int, int]:
    """Parse rate limit string like '30/minute' into (max_requests, window_seconds)."""
    parts = rate_str.split("/")
    count = int(parts[0])
    unit = parts[1] if len(parts) > 1 else "minute"
    window = {"second": 1, "minute": 60, "hour": 3600}.get(unit, 60)
    return count, window


async def check_rate_limit(request: Request) -> None:
    """Check if the request exceeds the configured rate limit.

    Raises an HTTPException (429) if limit is exceeded.
    """
    if not settings.rate_limit:
        return

    max_requests, window_seconds = _parse_rate_limit(settings.rate_limit)
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Sliding window: remove expired entries
    _request_counts[client_ip] = [
        t for t in _request_counts[client_ip] if now - t < window_seconds
    ]

    if len(_request_counts[client_ip]) >= max_requests:
        logger.warning("Rate limit exceeded for %s on %s", client_ip, request.url.path)
        from fastapi import HTTPException
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")

    _request_counts[client_ip].append(now)
