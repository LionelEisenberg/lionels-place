"""Important dates router — read-only "Upcoming" card for the dashboard.

The underlying list of birthdays/anniversaries/events is hard-coded in
``services.important_dates`` (no UI). Admin-only by default: the auth
middleware blocks any non-public, non-friend-allowed route for friends.
"""

import zoneinfo
from dataclasses import asdict
from datetime import datetime

from fastapi import APIRouter, Query

from ..schemas import ImportantDateResponse
from ..services.important_dates import upcoming_dates

router = APIRouter(prefix="/api/important-dates", tags=["important-dates"])

# The app's master "today" is Pacific-time everywhere (daily.py, meals.py,
# parse.py, tasks.py). Using ``date.today()`` here would key off the container's
# UTC clock and drift a day ahead in the evening, mislabeling "Tomorrow"/"in N
# days". Anchor to the same timezone so the card agrees with the rest of Helm.
_PACIFIC = zoneinfo.ZoneInfo("America/Los_Angeles")


@router.get("/upcoming", response_model=list[ImportantDateResponse])
async def get_upcoming(
    window: int = Query(30, description="Look-ahead window in days"),
) -> list[ImportantDateResponse]:
    """Curated upcoming birthdays, anniversaries, and events within ``window`` days.

    Always returns at least the single nearest upcoming date (unless there are
    none at all), so the dashboard card is never awkwardly empty.
    """
    window = max(1, min(window, 366))
    today = datetime.now(_PACIFIC).date()
    return [
        ImportantDateResponse(**asdict(u))
        for u in upcoming_dates(today, window)
    ]
