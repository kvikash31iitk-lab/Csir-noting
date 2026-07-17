#!/usr/bin/env bash
#
# One-shot deploy for note-api on a VPS. Supports two AI providers, chosen
# with AI_PROVIDER (default: antigravity — subscription CLI, no per-call
# billing; set AI_PROVIDER=openai to use the OpenAI API instead). Run it from
# inside the note-api/ folder:
#
#   cd note-api
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Override any setting inline, e.g.:
#   AI_PROVIDER=openai OPENAI_API_KEY=sk-... API_DOMAIN=noteapi.cheetsheet.tech SITE_ORIGIN=https://notesheet.cheetsheet.tech ./deploy.sh
#
set -euo pipefail

# ----------------------------- settings -----------------------------
AI_PROVIDER="${AI_PROVIDER:-antigravity}"
API_DOMAIN="${API_DOMAIN:-noteapi.cheetsheet.tech}"          # subdomain for the API
SITE_ORIGIN="${SITE_ORIGIN:-https://notesheet.cheetsheet.tech}"  # site allowed to call it (CORS)
PORT="${PORT:-8787}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"                            # optional, for Let's Encrypt
APP_NAME="note-api"

say() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m[!] %s\033[0m\n" "$*"; }

SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# ----------------------------- checks -----------------------------
say "Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is required (node -v). Install it first."; exit 1; }
command -v npm  >/dev/null || { echo "npm is required."; exit 1; }

if [ "$AI_PROVIDER" = "openai" ]; then
  EXISTING_OPENAI_API_KEY=""
  if [ -f .env ]; then
    EXISTING_OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2- || true)"
  fi
  OPENAI_API_KEY="${OPENAI_API_KEY:-$EXISTING_OPENAI_API_KEY}"
  OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.5}"
  OPENAI_VISION_MODEL="${OPENAI_VISION_MODEL:-$OPENAI_MODEL}"
  if [ -z "$OPENAI_API_KEY" ]; then
    warn "OPENAI_API_KEY is not set. Add it to .env or re-run with OPENAI_API_KEY=sk-..."
  fi
else
  # agy installs to ~/.local/bin, which is often NOT on pm2's PATH even when
  # it is on your interactive shell's PATH. Resolve a concrete absolute path
  # now and bake it into .env so the service doesn't depend on PATH at all.
  AGY_RESOLVED="$(command -v agy || true)"
  if [ -z "$AGY_RESOLVED" ] && [ -x "$HOME/.local/bin/agy" ]; then
    AGY_RESOLVED="$HOME/.local/bin/agy"
  fi
  if [ -z "$AGY_RESOLVED" ]; then
    warn "The 'agy' (Antigravity CLI) binary was not found on PATH or in ~/.local/bin. Generation will fail until it is installed and logged in: curl -fsSL https://antigravity.google/cli/install.sh | bash"
    AGY_RESOLVED="agy"
  else
    echo "  Found agy at: $AGY_RESOLVED"
  fi
fi

# ----------------------------- app -----------------------------
say "Installing dependencies"
npm install --omit=dev

say "Writing .env"
if [ "$AI_PROVIDER" = "openai" ]; then
  cat > .env <<ENV
PORT=$PORT
ALLOWED_ORIGIN=$SITE_ORIGIN
AI_PROVIDER=openai
OPENAI_API_KEY=$OPENAI_API_KEY
OPENAI_MODEL=$OPENAI_MODEL
OPENAI_VISION_MODEL=$OPENAI_VISION_MODEL
TIMEOUT_MS=120000
OCR_TIMEOUT_MS=180000
ENV
  echo "  PORT=$PORT  ALLOWED_ORIGIN=$SITE_ORIGIN  AI_PROVIDER=openai  OPENAI_MODEL=$OPENAI_MODEL"
else
  cat > .env <<ENV
PORT=$PORT
ALLOWED_ORIGIN=$SITE_ORIGIN
AI_PROVIDER=antigravity
AGY_BIN=$AGY_RESOLVED
TIMEOUT_MS=120000
OCR_TIMEOUT_MS=180000
ENV
  echo "  PORT=$PORT  ALLOWED_ORIGIN=$SITE_ORIGIN  AI_PROVIDER=antigravity  AGY_BIN=$AGY_RESOLVED"

  say "Quick self-test of the agy CLI (subscription)"
  if [ -x "$AGY_RESOLVED" ] || command -v "$AGY_RESOLVED" >/dev/null 2>&1; then
    if ("$AGY_RESOLVED" -p "reply with the single word OK" >/tmp/agy_test.out 2>/tmp/agy_test.err); then
      echo "  agy responded: $(cat /tmp/agy_test.out) (subscription auth working)."
    else
      warn "agy test did not succeed. Log in as this user once: 'agy' then choose 'Login with Google'. See: $(cat /tmp/agy_test.err 2>/dev/null | head -1)"
    fi
  fi
fi

say "Starting the service with pm2"
command -v pm2 >/dev/null || $SUDO npm install -g pm2
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start server.js --name "$APP_NAME"
pm2 save || true

# ----------------------------- nginx -----------------------------
if command -v nginx >/dev/null; then
  say "Configuring nginx for $API_DOMAIN"
  NGINX_CONF="/etc/nginx/sites-available/$API_DOMAIN"
  $SUDO tee "$NGINX_CONF" >/dev/null <<NGINX
server {
    listen 80;
    server_name $API_DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
    }
}
NGINX
  [ -d /etc/nginx/sites-enabled ] && $SUDO ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$API_DOMAIN"
  $SUDO nginx -t && $SUDO systemctl reload nginx
  echo "  nginx reloaded."
else
  warn "nginx not found — skipping reverse-proxy setup. The service is still running on 127.0.0.1:$PORT."
fi

# ----------------------------- https -----------------------------
say "Checking DNS for $API_DOMAIN"
if getent hosts "$API_DOMAIN" >/dev/null 2>&1; then
  if command -v certbot >/dev/null && command -v nginx >/dev/null; then
    say "Requesting HTTPS certificate (certbot)"
    if [ -n "$CERTBOT_EMAIL" ]; then
      $SUDO certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect || warn "certbot failed — you can run it manually later."
    else
      warn "Set CERTBOT_EMAIL=you@example.com and re-run, or run: sudo certbot --nginx -d $API_DOMAIN"
    fi
  else
    warn "certbot not installed — install it, then: sudo certbot --nginx -d $API_DOMAIN"
  fi
else
  warn "$API_DOMAIN does not resolve yet. Add a DNS A record pointing it to this server's IP, then run: sudo certbot --nginx -d $API_DOMAIN"
fi

# ----------------------------- done -----------------------------
say "Done"
echo "Local health check:"
echo "  curl -s localhost:$PORT/health"
echo
echo "Once DNS + HTTPS are ready, your endpoint is:"
echo "  https://$API_DOMAIN/generate"
echo
echo "Final step — open $SITE_ORIGIN, tap the gear (settings), set:"
echo "  Backend URL = https://$API_DOMAIN/generate"
echo "  then Save. Notes will generate via AI_PROVIDER=$AI_PROVIDER."
