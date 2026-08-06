#!/bin/sh
set -e

# Inject auth.json from base64 env var (set in Dokploy)
if [ -n "$AUTH_JSON_B64" ]; then
  mkdir -p data
  echo "$AUTH_JSON_B64" | base64 -d > data/auth.json
  echo "[entrypoint] auth.json injected"
fi

exec node dist/cli.js
