#!/bin/sh
# Hourly Google Health sync trigger (out-of-process; the in-process scheduler
# doesn't fire under uvicorn --reload). Pokes the helm container's internal
# sync endpoint, gated by HEALTH_SYNC_SECRET.
sleep "${INITIAL_DELAY:-30}"
while true; do
  if curl -fsS -m 120 -X POST -H "X-Sync-Secret: ${HEALTH_SYNC_SECRET}" \
       http://helm:8001/api/health/sync-internal; then
    echo "[health-sync] tick ok"
  else
    echo "[health-sync] tick failed"
  fi
  sleep "${INTERVAL:-3600}"
done
