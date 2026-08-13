#!/bin/sh
set -e

API_KEY="${PROXY_API_KEY:-moccilabs-freebuff-2026}"

# Inject auth.json from base64 env var, then patch proxy_id + session_model
if [ -n "$AUTH_JSON_B64" ]; then
  mkdir -p data
  echo "$AUTH_JSON_B64" | base64 -d > data/auth.json
  echo "[entrypoint] auth.json injected"
fi

# Patch auth.json:
# 1. Re-assign proxy_id round-robin to DO proxies (proxy-1 through proxy-5)
# 2. Set ALL accounts to deepseek/deepseek-v4-flash
node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync("data/auth.json", "utf8"));
  if (data.accounts && Array.isArray(data.accounts)) {
    data.accounts.forEach((acc, i) => {
      acc.proxy_id = "proxy-" + ((i % 5) + 1);
      acc.session_model = "deepseek/deepseek-v4-flash";
    });
    fs.writeFileSync("data/auth.json", JSON.stringify(data, null, 2));
    console.log("[entrypoint] patched " + data.accounts.length + " accounts: proxy_id round-robin(5) + session_model=flash");
  }
} catch (e) {
  console.error("[entrypoint] failed to patch auth.json:", e.message);
}
'

# Register DigitalOcean proxies on startup (5 unique IPs)
(
  sleep 8
  echo "[entrypoint] registering 5 DO proxies..."
  DO_USER="${DO_PROXY_USER:-fb}"
  DO_PASS="${DO_PROXY_PASS:-269c809c3c4ce873}"
  idx=1
  for entry in \
    "165.22.250.105:3128:DO-SGP1" \
    "104.236.101.57:3128:DO-NYC3" \
    "164.92.145.22:3128:DO-AMS3" \
    "68.183.68.237:3128:DO-FRA1" \
    "139.59.165.183:3128:DO-LON1"
  do
    IFS=':' read host port name <<EOF
$entry
EOF
    if [ -n "$host" ] && [ -n "$port" ]; then
      curl -s -X POST "http://localhost:9187/api/proxies" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"id\":\"proxy-$idx\",\"name\":\"$name\",\"type\":\"http\",\"host\":\"$host\",\"port\":${port},\"username\":\"$DO_USER\",\"password\":\"$DO_PASS\"}" \
        > /dev/null 2>&1 && echo "[entrypoint] registered proxy-$idx $name" || true
      idx=$((idx + 1))
    fi
  done
  echo "[entrypoint] DO proxy registration complete"
) &

exec node dist/cli.js
