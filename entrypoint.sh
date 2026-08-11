#!/bin/sh
set -e

API_KEY="${PROXY_API_KEY:-moccilabs-freebuff-2026}"

# Inject auth.json from base64 env var, then patch proxy_id assignments to DO proxies
if [ -n "$AUTH_JSON_B64" ]; then
  mkdir -p data
  echo "$AUTH_JSON_B64" | base64 -d > data/auth.json
  echo "[entrypoint] auth.json injected"
fi

# Patch auth.json: re-assign proxy_id round-robin to DO proxies (proxy-1 through proxy-10)
# This overrides stale Webshare proxy_id assignments from AUTH_JSON_B64
node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync("data/auth.json", "utf8"));
  if (data.accounts && Array.isArray(data.accounts)) {
    data.accounts.forEach((acc, i) => {
      acc.proxy_id = "proxy-" + ((i % 10) + 1);
    });
    fs.writeFileSync("data/auth.json", JSON.stringify(data, null, 2));
    console.log("[entrypoint] patched proxy_id for " + data.accounts.length + " accounts across 10 DO proxies");
  }
} catch (e) {
  console.error("[entrypoint] failed to patch auth.json:", e.message);
}
'

# Register DigitalOcean proxies on startup (10 unique IPs across 10 regions)
(
  sleep 8
  echo "[entrypoint] registering 10 DO proxies..."
  DO_USER="${DO_PROXY_USER:-fb}"
  DO_PASS="${DO_PROXY_PASS:-269c809c3c4ce873}"
  idx=1
  IFS=','
  for entry in \
    "157.230.247.151:3128:DO-SGP1-1" \
    "159.223.32.16:3128:DO-SGP1-2" \
    "104.131.38.73:3128:DO-NYC3-3" \
    "146.190.22.253:3128:DO-AMS3-4" \
    "165.227.157.114:3128:DO-FRA1-5" \
    "139.59.180.46:3128:DO-LON1-6" \
    "159.89.112.231:3128:DO-TOR1-7" \
    "168.144.113.165:3128:DO-BLR1-8" \
    "209.38.81.119:3128:DO-SYD1-9" \
    "146.190.122.10:3128:DO-SFO3-10"
  do
    IFS=':' read host port name <<EOF
$entry
EOF
    if [ -n "$host" ] && [ -n "$port" ]; then
      curl -s -X POST "http://localhost:9187/api/proxies" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"id\":\"proxy-$idx\",\"name\":\"$name\",\"type\":\"http\",\"host\":\"$host\",\"port\":${port},\"username\":\"$DO_USER\",\"password\":\"$DO_PASS\"}" \
        > /dev/null 2>&1 && echo "[entrypoint] registered proxy-$idx $name $host:$port" || true
      idx=$((idx + 1))
    fi
  done
  echo "[entrypoint] DO proxy registration complete"
) &

exec node dist/cli.js
