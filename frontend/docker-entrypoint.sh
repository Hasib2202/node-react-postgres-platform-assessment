#!/bin/sh
# Picked up automatically by the nginx image (/docker-entrypoint.d/*.sh).
# Lets one immutable image run in every environment: the API base URL is
# injected at container start instead of being baked in at build time.
set -eu

API_BASE_URL="${API_BASE_URL:-/api}"
# Escape characters that would break out of the JS string literal.
SAFE=$(printf '%s' "$API_BASE_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'window.__CONFIG__ = { API_BASE_URL: "%s" };\n' "$SAFE" > /usr/share/nginx/html/config.js
echo "config.js written (API_BASE_URL=$API_BASE_URL)"
