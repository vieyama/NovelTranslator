#!/bin/sh

interval="${OFFPEAK_INTERVAL_SECONDS:-900}"

case "$interval" in
  ''|*[!0-9]*)
    echo "[offpeak-worker] OFFPEAK_INTERVAL_SECONDS must be an integer of at least 60." >&2
    exit 1
    ;;
esac

if [ "$interval" -lt 60 ]; then
  echo "[offpeak-worker] OFFPEAK_INTERVAL_SECONDS must be an integer of at least 60." >&2
  exit 1
fi

while true; do
  bun --conditions=react-server scripts/translate-offpeak.ts
  sleep "$interval"
done
