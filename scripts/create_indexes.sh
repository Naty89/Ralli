#!/bin/sh
set -euo pipefail

# Usage:
# 1) Export DATABASE_URL and run: ./scripts/create_indexes.sh
# 2) Or pass the URL as first arg: ./scripts/create_indexes.sh "postgresql://..."

DB_URL="${1:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "Usage: DATABASE_URL=... $0 or $0 <DATABASE_URL>"
  exit 1
fi

echo "Creating unique indexes concurrently on \`ride_requests\`..."

psql "$DB_URL" -c "CREATE UNIQUE INDEX CONCURRENTLY uniq_active_ride_per_rider_identifier ON ride_requests (event_id, rider_identifier_hash) WHERE rider_identifier_hash IS NOT NULL AND status IN ('waiting','assigned','arrived','in_progress');"
echo "-> uniq_active_ride_per_rider_identifier created (or already exists)"

psql "$DB_URL" -c "CREATE UNIQUE INDEX CONCURRENTLY uniq_active_ride_per_phone ON ride_requests (event_id, rider_phone_normalized) WHERE rider_phone_normalized IS NOT NULL AND status IN ('waiting','assigned','arrived','in_progress');"
echo "-> uniq_active_ride_per_phone created (or already exists)"

echo "Done. Verify with the verification queries in the repo or Supabase SQL editor."
