"""Daily cookie health check — detects notebooklm-py auth expiry before it causes failures."""

import logging

from coachiq.config import settings
from coachiq.services.alerting import alert_cookie_expired
from coachiq.services.notebooklm import health_check

logger = logging.getLogger(__name__)

# Track consecutive failures for escalation
_consecutive_failures = 0


async def run_health_check():
    """Check notebooklm-py cookie health. Alert on expiry."""
    global _consecutive_failures

    healthy = await health_check(settings.notebooklm_storage_path)

    if healthy:
        if _consecutive_failures > 0:
            logger.info("Cookie health restored after %d failures", _consecutive_failures)
        _consecutive_failures = 0
        logger.info("Cookie health check: HEALTHY")
        return {"status": "healthy"}

    _consecutive_failures += 1
    logger.warning("Cookie health check: EXPIRED (failure #%d)", _consecutive_failures)

    if _consecutive_failures >= 2:
        alert_cookie_expired()
        logger.warning("Escalated: 2+ consecutive cookie failures")

    return {"status": "expired", "consecutive_failures": _consecutive_failures}
