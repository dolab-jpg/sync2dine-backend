#!/usr/bin/env bash
# Probe local Sync2Dine API health. On consecutive failures: restart + notify.
# Designed to run from cron every minute (Node may be down — do not rely on the API).
set -euo pipefail

BE="${SYNC2DINE_BACKEND_DIR:-/var/www/vhosts/sync2dine.io/sync2dine-backend}"
CONTACTS_FILE="${OPS_CONTACTS_FILE:-$BE/server/data/ops-contacts.json}"
STATE_FILE="${OPS_WATCHDOG_STATE:-/tmp/sync2dine-api-watchdog.state}"
LOG_FILE="${OPS_WATCHDOG_LOG:-/tmp/sync2dine-api-watchdog.log}"
HEALTH_URL="${OPS_HEALTH_URL:-http://127.0.0.1:3011/health}"
PUBLIC_HEALTH="${OPS_PUBLIC_HEALTH_URL:-https://app.sync2dine.io/health}"
FAIL_THRESHOLD="${OPS_FAIL_THRESHOLD:-2}"
ALERT_COOLDOWN_SEC="${OPS_ALERT_COOLDOWN_SEC:-900}"
DEFAULT_EMAIL="${OPS_ALERT_EMAIL:-dolab@diamondea.co.uk}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$LOG_FILE"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_FILE"; }

read_state() {
  fails=0
  last_alert=0
  was_down=0
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE" || true
  fi
  fails=${fails:-0}
  last_alert=${last_alert:-0}
  was_down=${was_down:-0}
}

write_state() {
  cat >"$STATE_FILE" <<EOF
fails=$1
last_alert=$2
was_down=$3
EOF
}

contacts_json() {
  if [[ -f "$CONTACTS_FILE" ]]; then
    cat "$CONTACTS_FILE"
  else
    printf '{"alertEmail":"%s","alertPhone":"","traeWebhookUrl":""}\n' "$DEFAULT_EMAIL"
  fi
}

# Load SMTP/Twilio from API .env when present (for curl/mail helpers).
load_env() {
  if [[ -f "$BE/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$BE/.env" 2>/dev/null || true
    set +a
  fi
}

extract_field() {
  local key="$1"
  python3 - "$key" <<'PY' 2>/dev/null || true
import json,sys
key=sys.argv[1]
try:
  data=json.load(sys.stdin)
except Exception:
  print(""); raise SystemExit(0)
v=data.get(key) or ""
print(str(v).strip())
PY
}

send_email() {
  local subject="$1" body="$2" to="$3"
  [[ -z "$to" ]] && return 0
  load_env
  local host="${SMTP_HOST:-}" user="${SMTP_USER:-${SMTP_USERNAME:-}}" pass="${SMTP_PASSWORD:-${SMTP_PASS:-}}"
  local from="${SMTP_FROM:-${SMTP_FROM_EMAIL:-$user}}"
  local port="${SMTP_PORT:-587}"
  if [[ -z "$host" || -z "$user" || -z "$from" ]]; then
    log "email_skip smtp_not_configured to=$to"
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    # Prefer node one-liner if available (handles TLS/auth correctly).
    if [[ -x /opt/plesk/node/24/bin/node && -d "$BE/node_modules/nodemailer" ]]; then
      (
        cd "$BE"
        SUBJECT="$subject" BODY="$body" TO="$to" FROM="$from" HOST="$host" PORT="$port" USER="$user" PASS="$pass" \
        /opt/plesk/node/24/bin/node --input-type=module -e '
          import nodemailer from "nodemailer";
          const t = nodemailer.createTransport({
            host: process.env.HOST,
            port: Number(process.env.PORT||587),
            secure: process.env.SMTP_SECURE === "true",
            auth: { user: process.env.USER, pass: process.env.PASS },
          });
          await t.sendMail({
            from: process.env.FROM,
            to: process.env.TO,
            subject: process.env.SUBJECT,
            text: process.env.BODY,
          });
        '
      ) 2>>"$LOG_FILE" && log "email_ok to=$to" && return 0 || log "email_fail to=$to"
    fi
  fi
  log "email_skip no_mailer to=$to"
}

send_sms() {
  local to="$1" text="$2"
  [[ -z "$to" ]] && return 0
  load_env
  local sid="${TWILIO_ACCOUNT_SID:-}" token="${TWILIO_AUTH_TOKEN:-}" from="${TWILIO_FROM_NUMBER:-${TWILIO_PHONE_NUMBER:-}}"
  if [[ -z "$sid" || -z "$token" || -z "$from" ]]; then
    log "sms_skip twilio_not_configured"
    return 0
  fi
  curl -fsS -X POST "https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json" \
    -u "${sid}:${token}" \
    --data-urlencode "To=${to}" \
    --data-urlencode "From=${from}" \
    --data-urlencode "Body=${text}" \
    >/dev/null 2>>"$LOG_FILE" && log "sms_ok to=$to" || log "sms_fail to=$to"
}

send_webhook() {
  local url="$1" event="$2" title="$3" message="$4"
  [[ -z "$url" ]] && return 0
  local at payload
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  payload=$(
    EVENT="$event" TITLE="$title" MESSAGE="$message" AT="$at" HEALTH="$PUBLIC_HEALTH" python3 - <<'PY'
import json, os
print(json.dumps({
  "source": "sync2dine-ops",
  "event": os.environ["EVENT"],
  "severity": "critical",
  "title": os.environ["TITLE"],
  "message": os.environ["MESSAGE"],
  "at": os.environ["AT"],
  "healthUrl": os.environ["HEALTH"],
}))
PY
  )
  curl -fsS -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: sync2dine-ops-watchdog/1' \
    --max-time 8 \
    -d "$payload" >/dev/null 2>>"$LOG_FILE" && log "webhook_ok event=$event" || log "webhook_fail event=$event"
}

notify_all() {
  local event="$1" title="$2" message="$3"
  local json email phone hook
  json=$(contacts_json)
  email=$(printf '%s' "$json" | extract_field alertEmail)
  phone=$(printf '%s' "$json" | extract_field alertPhone)
  hook=$(printf '%s' "$json" | extract_field traeWebhookUrl)
  [[ -z "$email" ]] && email="$DEFAULT_EMAIL"
  send_email "$title" "$message"$'\n'"Event: $event"$'\n'"Health: $PUBLIC_HEALTH" "$email"
  send_sms "$phone" "Sync2Dine: $title — $message"
  send_webhook "$hook" "$event" "$title" "$message"
}

probe_ok() {
  curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

read_state
now=$(date +%s)

if probe_ok; then
  if [[ "$was_down" == "1" ]]; then
    log "recovered after fails"
    notify_all "api_recovered" "Sync2Dine API recovered" "https://app.sync2dine.io/health is responding again after an outage."
  fi
  write_state 0 "$last_alert" 0
  exit 0
fi

fails=$((fails + 1))
log "health_fail fails=$fails url=$HEALTH_URL"
write_state "$fails" "$last_alert" 1

if [[ "$fails" -lt "$FAIL_THRESHOLD" ]]; then
  exit 0
fi

# Attempt restart
if [[ -x "$BE/scripts/restart-sync2dine-api.sh" ]]; then
  log "restart_attempt"
  bash "$BE/scripts/restart-sync2dine-api.sh" >>"$LOG_FILE" 2>&1 || log "restart_failed"
  sleep 2
fi

if probe_ok; then
  log "restart_healed"
  # Still notify so owners know there was a blip
  if [[ $((now - last_alert)) -ge "$ALERT_COOLDOWN_SEC" ]]; then
    notify_all "api_recovered" "Sync2Dine API auto-restarted" "Local health failed; watchdog restarted the API and it is healthy again."
    write_state 0 "$now" 0
  else
    write_state 0 "$last_alert" 0
  fi
  exit 0
fi

if [[ $((now - last_alert)) -ge "$ALERT_COOLDOWN_SEC" ]]; then
  notify_all "api_down" "URGENT: Sync2Dine API down" "Health check failed ${fails}x. nginx may return 502; phone webhooks will reject. Watchdog attempted restart."
  write_state "$fails" "$now" 1
else
  log "alert_suppressed cooldown"
fi

exit 0
