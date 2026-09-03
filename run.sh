#!/usr/bin/env bash
# Start the Insider Tracker web server.
set -euo pipefail
cd "$(dirname "$0")"
export EDGAR_USER_AGENT="${EDGAR_USER_AGENT:-insider-tracker your-email@example.com}"
exec .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
