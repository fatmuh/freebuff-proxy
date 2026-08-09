#!/bin/sh
set -e

# Inject auth.json from base64 env var
if [ -n "$AUTH_JSON_B64" ]; then
  mkdir -p data
  echo "$AUTH_JSON_B64" | base64 -d > data/auth.json
  echo "[entrypoint] auth.json injected"
fi

# Auto-register Webshare proxies on startup
# Set WEBSHARE_PROXY_HOSTS="host1:port1:country1,host2:port2:country2,..."
# Set WEBSHARE_USER and WEBSHARE_PASS
if [ -n "$WEBSHARE_PROXY_HOSTS" ] && [ -n "$WEBSHARE_USER" ]; then
  echo "[entrypoint] registering Webshare proxies..."
  # Wait for server to be ready, then register via API
  (
    sleep 10
    IFS=','
    for entry in $WEBSHARE_PROXY_HOSTS; do
      IFS=':' read host port country <<EOF
$entry
EOF
      if [ -n "$host" ] && [ -n "$port" ]; then
        curl -s -X POST "http://localhost:9187/api/proxies" \
          -H "Authorization: Bearer ${PROXY_API_KEY:-moccilabs-freebuff-2026}" \
          -H "Content-Type: application/json" \
          -d "{\"name\":\"WS ${country:-??}\",\"type\":\"http\",\"host\":\"$host\",\"port\":${port},\"username\":\"$WEBSHARE_USER\",\"password\":\"${WEBSHARE_PASS:-}\"}" \
          > /dev/null 2>&1 && echo "[entrypoint] registered $host:$port" || true
      fi
    done
    echo "[entrypoint] Webshare proxy registration complete"
  ) &
fi

exec node dist/cli.js
