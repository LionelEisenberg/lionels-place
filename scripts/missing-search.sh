#!/bin/sh
# Periodically trigger Sonarr's "search for all missing monitored episodes".
#
# Why this exists: RSS sync on high-volume public indexers (e.g. The Pirate Bay)
# drops releases between syncs -- the feed churns faster than Sonarr's window, so
# Sonarr logs "rss sync didn't cover the period ... Search may be required" and a
# newly-aired episode never gets grabbed. A targeted search is NOT volume-limited,
# so re-searching missing episodes on a timer reliably catches what RSS missed.
#
# Runs inside the compose network and reaches Sonarr by service name.
set -u

: "${INTERVAL:=86400}"            # seconds between runs (default 24h)
: "${SONARR_URL:=http://sonarr:8989}"

if [ -z "${SONARR_API_KEY:-}" ]; then
  echo "ERROR: SONARR_API_KEY is not set; cannot trigger searches." >&2
  exit 1
fi

echo "scheduled-search: starting (interval=${INTERVAL}s, target=${SONARR_URL})"
while true; do
  ts=$(date -u '+%Y-%m-%d %H:%M:%SZ')
  if curl -fsS -X POST "${SONARR_URL}/api/v3/command" \
       -H "X-Api-Key: ${SONARR_API_KEY}" \
       -H "Content-Type: application/json" \
       -d '{"name":"MissingEpisodeSearch"}' >/dev/null; then
    echo "[${ts}] MissingEpisodeSearch queued"
  else
    echo "[${ts}] MissingEpisodeSearch trigger FAILED" >&2
  fi
  sleep "${INTERVAL}"
done
