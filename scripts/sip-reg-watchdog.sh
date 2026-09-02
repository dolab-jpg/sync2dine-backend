#!/usr/bin/env bash
# Probe Asterisk pjsip registrations for enabled AI lines. Notify on sustained failure / recovery.
# On sustained Rejected/Unregistered: auto-recreate the Asterisk bridge (clears auth_rejection_permanent).
# Cron every 2 minutes — does not rely on the Sync2Dine API process for the probe itself.
set -euo pipefail

BE="${SYNC2DINE_BACKEND_DIR:-/var/www/vhosts/sync2dine.io/sync2dine-backend}"
CONTACTS_FILE="${OPS_CONTACTS_FILE:-$BE/server/data/ops-contacts.json}"
STATE_FILE="${SIP_WATCHDOG_STATE:-/tmp/sync2dine-sip-watchdog.state}"
RECOVER_STATE_FILE="${SIP_WATCHDOG_RECOVER_STATE:-/tmp/sync2dine-sip-watchdog-recover}"
LOG_FILE="${SIP_WATCHDOG_LOG:-/tmp/sync2dine-sip-watchdog.log}"
FAIL_THRESHOLD="${SIP_FAIL_THRESHOLD:-2}"
ALERT_COOLDOWN_SEC="${SIP_ALERT_COOLDOWN_SEC:-900}"
RECOVER_COOLDOWN_SEC="${SIP_RECOVER_COOLDOWN_SEC:-1800}"
RECOVER_WAIT_SEC="${SIP_RECOVER_WAIT_SEC:-15}"
API_BASE="${SIP_WATCHDOG_API_BASE:-http://127.0.0.1:3011}"
BRIDGE_DIR="${SOHO66_BRIDGE_DIR:-/var/www/vhosts/b-diddies.com/tradepro-sip-bridge}"
DEFAULT_EMAIL="${OPS_ALERT_EMAIL:-dolab@diamondea.co.uk}"
PUBLIC_HEALTH="${OPS_PUBLIC_HEALTH_URL:-https://app.sync2dine.io/health}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$LOG_FILE"
touch "$RECOVER_STATE_FILE"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_FILE"; }

contacts_json() {
  if [[ -f "$CONTACTS_FILE" ]]; then
    cat "$CONTACTS_FILE"
  else
    printf '{"alertEmail":"%s","alertPhone":"","traeWebhookUrl":""}\n' "$DEFAULT_EMAIL"
  fi
}

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

  local node_bin=""
  if [[ -x /opt/plesk/node/24/bin/node ]]; then
    node_bin=/opt/plesk/node/24/bin/node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi
  local tsx_cli="$BE/node_modules/tsx/dist/cli.mjs"
  if [[ -n "$node_bin" && -f "$BE/scripts/ops-send-alert-email.ts" && -f "$tsx_cli" ]]; then
    if (
      cd "$BE"
      "$node_bin" "$tsx_cli" --env-file=.env scripts/ops-send-alert-email.ts \
        --to "$to" --subject "$subject" --body "$body"
    ) >>"$LOG_FILE" 2>&1; then
      log "email_ok via=gmail_or_smtp to=$to"
      return 0
    fi
    log "email_fail gmail_cli to=$to"
  fi

  local host="${SMTP_HOST:-}" user="${SMTP_USER:-${SMTP_USERNAME:-}}" pass="${SMTP_PASSWORD:-${SMTP_PASS:-}}"
  local from="${SMTP_FROM:-${SMTP_FROM_EMAIL:-$user}}"
  local port="${SMTP_PORT:-587}"
  if [[ -z "$host" || -z "$user" || -z "$from" ]]; then
    log "email_skip smtp_not_configured to=$to"
    return 0
  fi
  if [[ -n "$node_bin" && -d "$BE/node_modules/nodemailer" ]]; then
    (
      cd "$BE"
      SUBJECT="$subject" BODY="$body" TO="$to" FROM="$from" HOST="$host" PORT="$port" USER="$user" PASS="$pass" \
      "$node_bin" --input-type=module -e '
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
    ) 2>>"$LOG_FILE" && log "email_ok via=smtp to=$to" && return 0 || log "email_fail smtp to=$to"
  fi
  log "email_skip no_mailer to=$to"
}

send_sms() {
  local to="$1" text="$2" kind="${3:-}" persona="${4:-}" did="${5:-}"
  [[ -z "$to" ]] && return 0
  load_env

  local node_bin=""
  if [[ -x /opt/plesk/node/24/bin/node ]]; then
    node_bin=/opt/plesk/node/24/bin/node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi
  local tsx_cli="$BE/node_modules/tsx/dist/cli.mjs"
  if [[ -n "$node_bin" && -f "$BE/scripts/ops-send-alert-sms.ts" && -f "$tsx_cli" ]]; then
    local sms_kind="$kind"
    [[ -z "$sms_kind" ]] && sms_kind="ops_alert"
    if (
      cd "$BE"
      "$node_bin" "$tsx_cli" --env-file=.env scripts/ops-send-alert-sms.ts \
        --to "$to" --kind "$sms_kind" --persona "$persona" --did "$did" --title "$text" --message ""
    ) >>"$LOG_FILE" 2>&1; then
      log "sms_ok via=cli to=$to kind=$sms_kind"
      return 0
    fi
    log "sms_fail cli to=$to kind=$sms_kind"
  fi

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
    -H 'User-Agent: sync2dine-sip-watchdog/1' \
    --max-time 8 \
    -d "$payload" >/dev/null 2>>"$LOG_FILE" && log "webhook_ok event=$event" || log "webhook_fail event=$event"
}

notify_line() {
  local event="$1" title="$2" sms_body="$3" detail="$4" persona="${5:-}" did="${6:-}"
  local json email phone hook kind
  json=$(contacts_json)
  email=$(printf '%s' "$json" | extract_field alertEmail)
  phone=$(printf '%s' "$json" | extract_field alertPhone)
  hook=$(printf '%s' "$json" | extract_field traeWebhookUrl)
  [[ -z "$email" ]] && email="$DEFAULT_EMAIL"
  if [[ "$event" == "sip_line_down" ]]; then
    kind="phone_line_down"
  elif [[ "$event" == "sip_line_recovered" ]]; then
    kind="phone_line_up"
  else
    kind="ops_alert"
  fi
  send_email "$title" "${detail}"$'\n'"Event: $event"$'\n'"Health: $PUBLIC_HEALTH" "$email"
  send_sms "$phone" "$sms_body" "$kind" "$persona" "$did"
  send_webhook "$hook" "$event" "$title" "$detail"
}

run_probe() {
  local node_bin=""
  if [[ -x /opt/plesk/node/24/bin/node ]]; then
    node_bin=/opt/plesk/node/24/bin/node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi
  local tsx_cli="$BE/node_modules/tsx/dist/cli.mjs"
  if [[ -z "$node_bin" || ! -f "$BE/scripts/sip-reg-watchdog.mts" || ! -f "$tsx_cli" ]]; then
    log "probe_skip node_or_helper_missing"
    exit 0
  fi
  (
    cd "$BE"
    "$node_bin" "$tsx_cli" scripts/sip-reg-watchdog.mts
  ) 2>>"$LOG_FILE"
}

sync_stored_status() {
  # Best-effort: refresh API-stored line status from live Asterisk so the UI matches reality.
  curl -fsS --max-time 45 \
    "${API_BASE}/api/platform/phone-lines/registration-status" \
    >/dev/null 2>>"$LOG_FILE" && log "status_sync_ok" || log "status_sync_fail"
}

attempt_recover() {
  log "recover_start reason=sustained_bad_registration"
  # Prefer the API Go-live path (rewrites lines.json + recreates + updates stored status + BYO).
  if curl -fsS --max-time 180 \
    -X POST "${API_BASE}/api/platform/phone-lines/sync-asterisk-bridge" \
    -H 'Content-Type: application/json' \
    -d '{"apply":true}' \
    >>"$LOG_FILE" 2>&1; then
    log "recover_ok via=api_sync"
    echo "$(date +%s)" >"$RECOVER_STATE_FILE"
    return 0
  fi
  log "recover_api_fail falling_back_to_docker"
  if [[ -d "$BRIDGE_DIR" ]] && command -v docker >/dev/null 2>&1; then
    if (
      cd "$BRIDGE_DIR"
      docker compose up -d --force-recreate
    ) >>"$LOG_FILE" 2>&1; then
      log "recover_ok via=docker_recreate"
      echo "$(date +%s)" >"$RECOVER_STATE_FILE"
      sleep "$RECOVER_WAIT_SEC"
      sync_stored_status
      return 0
    fi
  fi
  log "recover_fail"
  return 1
}

PROBE_JSON=$(run_probe || true)
if [[ -z "$PROBE_JSON" ]]; then
  log "probe_empty"
  exit 0
fi

# Sync stored statuses every tick so Call Centre / Sally / Judie badges match Asterisk.
sync_stored_status

DECIDE=$(
  STATE_FILE="$STATE_FILE" FAIL_THRESHOLD="$FAIL_THRESHOLD" ALERT_COOLDOWN_SEC="$ALERT_COOLDOWN_SEC" \
  RECOVER_STATE_FILE="$RECOVER_STATE_FILE" RECOVER_COOLDOWN_SEC="$RECOVER_COOLDOWN_SEC" \
  python3 - "$PROBE_JSON" <<'PY'
import json, os, sys, time

state_path = os.environ["STATE_FILE"]
recover_path = os.environ["RECOVER_STATE_FILE"]
fail_threshold = int(os.environ.get("FAIL_THRESHOLD", "2"))
cooldown = int(os.environ.get("ALERT_COOLDOWN_SEC", "900"))
recover_cooldown = int(os.environ.get("RECOVER_COOLDOWN_SEC", "1800"))
now = int(time.time())

def load_state():
    out = {}
    if not os.path.isfile(state_path):
        return out
    with open(state_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) != 4:
                continue
            user, fails, last_alert, was_down = parts
            out[user] = {
                "fails": int(fails or 0),
                "last_alert": int(last_alert or 0),
                "was_down": int(was_down or 0),
            }
    return out

def save_state(state):
    lines = []
    for user in sorted(state.keys()):
        s = state[user]
        lines.append(f"{user}|{s['fails']}|{s['last_alert']}|{s['was_down']}")
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    os.replace(tmp, state_path)

def last_recover_at():
    if not os.path.isfile(recover_path):
        return 0
    try:
        with open(recover_path, "r", encoding="utf-8") as f:
            return int((f.read() or "0").strip() or "0")
    except Exception:
        return 0

try:
    probe = json.loads(sys.argv[1])
except Exception:
    print(json.dumps({"exit_reason": "probe_invalid", "actions": [], "recover": False}))
    raise SystemExit(0)

if not probe.get("ok"):
    print(json.dumps({"exit_reason": probe.get("reason", "probe_not_ok"), "actions": [], "recover": False}))
    raise SystemExit(0)

lines = probe.get("lines") or []
if not lines:
    print(json.dumps({"exit_reason": "no_lines", "actions": [], "recover": False}))
    raise SystemExit(0)

state = load_state()
actions = []
sustained_bad = False

for line in lines:
    user = str(line.get("sipUsername") or "")
    if not user:
        continue
    s = state.setdefault(user, {"fails": 0, "last_alert": 0, "was_down": 0})
    bad = bool(line.get("bad"))
    agent = line.get("agentName") or "Judie"
    human_did = line.get("humanDid") or line.get("did") or "unknown number"
    sms_down = line.get("smsDown") or f"{agent} on {human_did} is offline. Callers to that number may not get through."
    sms_up = line.get("smsUp") or f"{agent} on {human_did} is back online."
    live_status = str(line.get("status") or "")

    if bad:
        s["fails"] = s.get("fails", 0) + 1
        if s["fails"] >= fail_threshold:
            sustained_bad = True
        if s["fails"] >= fail_threshold and (now - s.get("last_alert", 0)) >= cooldown:
            title = f"{agent} on {human_did} is offline"
            detail = (
                f"{agent} on {human_did} is offline after {s['fails']} checks "
                f"(Asterisk status: {live_status or 'not Registered'}). "
                f"Callers to that number may not get through."
            )
            actions.append({
                "event": "sip_line_down",
                "sipUsername": user,
                "title": title,
                "sms": sms_down,
                "detail": detail,
                "persona": agent,
                "did": human_did,
            })
            s["last_alert"] = now
            s["was_down"] = 1
    else:
        if s.get("was_down"):
            title = f"{agent} on {human_did} is back online"
            detail = f"{agent} on {human_did} is back online."
            actions.append({
                "event": "sip_line_recovered",
                "sipUsername": user,
                "title": title,
                "sms": sms_up,
                "detail": detail,
                "persona": agent,
                "did": human_did,
            })
        s["fails"] = 0
        s["was_down"] = 0

recover = False
if sustained_bad and (now - last_recover_at()) >= recover_cooldown:
    recover = True

save_state(state)
print(json.dumps({"exit_reason": "ok", "actions": actions, "recover": recover}))
PY
)

EXIT_REASON=$(printf '%s' "$DECIDE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("exit_reason",""))' 2>/dev/null || echo "parse_error")
if [[ "$EXIT_REASON" != "ok" ]]; then
  log "probe_exit reason=$EXIT_REASON"
  exit 0
fi

RECOVER=$(printf '%s' "$DECIDE" | python3 -c 'import json,sys; print("1" if json.load(sys.stdin).get("recover") else "0")' 2>/dev/null || echo "0")
if [[ "$RECOVER" == "1" ]]; then
  if attempt_recover; then
    # Re-probe after recover so recovery alerts fire on this tick when lines come back.
    PROBE_JSON=$(run_probe || true)
    if [[ -n "$PROBE_JSON" ]]; then
      DECIDE=$(
        STATE_FILE="$STATE_FILE" FAIL_THRESHOLD="$FAIL_THRESHOLD" ALERT_COOLDOWN_SEC="$ALERT_COOLDOWN_SEC" \
        RECOVER_STATE_FILE="$RECOVER_STATE_FILE" RECOVER_COOLDOWN_SEC="$RECOVER_COOLDOWN_SEC" \
        python3 - "$PROBE_JSON" <<'PY'
import json, os, sys, time

state_path = os.environ["STATE_FILE"]
fail_threshold = int(os.environ.get("FAIL_THRESHOLD", "2"))
cooldown = int(os.environ.get("ALERT_COOLDOWN_SEC", "900"))
now = int(time.time())

def load_state():
    out = {}
    if not os.path.isfile(state_path):
        return out
    with open(state_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) != 4:
                continue
            user, fails, last_alert, was_down = parts
            out[user] = {
                "fails": int(fails or 0),
                "last_alert": int(last_alert or 0),
                "was_down": int(was_down or 0),
            }
    return out

def save_state(state):
    lines = []
    for user in sorted(state.keys()):
        s = state[user]
        lines.append(f"{user}|{s['fails']}|{s['last_alert']}|{s['was_down']}")
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    os.replace(tmp, state_path)

try:
    probe = json.loads(sys.argv[1])
except Exception:
    print(json.dumps({"exit_reason": "probe_invalid", "actions": [], "recover": False}))
    raise SystemExit(0)

if not probe.get("ok"):
    print(json.dumps({"exit_reason": probe.get("reason", "probe_not_ok"), "actions": [], "recover": False}))
    raise SystemExit(0)

lines = probe.get("lines") or []
state = load_state()
actions = []

for line in lines:
    user = str(line.get("sipUsername") or "")
    if not user:
        continue
    s = state.setdefault(user, {"fails": 0, "last_alert": 0, "was_down": 0})
    bad = bool(line.get("bad"))
    agent = line.get("agentName") or "Judie"
    human_did = line.get("humanDid") or line.get("did") or "unknown number"
    sms_down = line.get("smsDown") or f"{agent} on {human_did} is offline. Callers to that number may not get through."
    sms_up = line.get("smsUp") or f"{agent} on {human_did} is back online."
    live_status = str(line.get("status") or "")

    if bad:
        s["fails"] = max(s.get("fails", 0), fail_threshold)
        if (now - s.get("last_alert", 0)) >= cooldown:
            title = f"{agent} on {human_did} is offline"
            detail = (
                f"{agent} on {human_did} still offline after auto-recover "
                f"(Asterisk status: {live_status or 'not Registered'})."
            )
            actions.append({
                "event": "sip_line_down",
                "sipUsername": user,
                "title": title,
                "sms": sms_down,
                "detail": detail,
                "persona": agent,
                "did": human_did,
            })
            s["last_alert"] = now
            s["was_down"] = 1
    else:
        if s.get("was_down") or s.get("fails", 0) > 0:
            title = f"{agent} on {human_did} is back online"
            detail = f"{agent} on {human_did} is back online after auto-recover."
            actions.append({
                "event": "sip_line_recovered",
                "sipUsername": user,
                "title": title,
                "sms": sms_up,
                "detail": detail,
                "persona": agent,
                "did": human_did,
            })
        s["fails"] = 0
        s["was_down"] = 0

save_state(state)
print(json.dumps({"exit_reason": "ok", "actions": actions, "recover": False}))
PY
      )
    fi
  fi
fi

while IFS= read -r action_line; do
  [[ -z "$action_line" ]] && continue
  event=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["event"])')
  title=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])')
  sms=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sms"])')
  detail=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["detail"])')
  user=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sipUsername"])')
  persona=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("persona") or "")')
  did=$(printf '%s' "$action_line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("did") or "")')
  log "notify event=$event user=$user"
  notify_line "$event" "$title" "$sms" "$detail" "$persona" "$did"
done < <(printf '%s' "$DECIDE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for a in data.get("actions") or []:
    print(json.dumps(a))
')

log "tick lines_checked=$(printf '%s' "$PROBE_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("lines") or []))' 2>/dev/null || echo 0) recover=$RECOVER"
exit 0
