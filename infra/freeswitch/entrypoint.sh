#!/usr/bin/env sh
set -eu

TEMPLATE_DIR="${TEMPLATE_DIR:-/opt/outbound-dialer/templates}"
GENERATED_DIR="${FREESWITCH_GENERATED_CONFIG_DIR:-/var/lib/outbound-dialer/freeswitch}"
CONFIG_DIR="${FREESWITCH_CONFIG_DIR:-/usr/share/freeswitch/conf/vanilla}"
LOG_DIR="${FREESWITCH_LOG_DIR:-/var/log/freeswitch}"
DB_DIR="${FREESWITCH_DB_DIR:-/var/lib/freeswitch/db}"

required() {
  name="$1"
  value="$(eval "printf '%s' \"\${$name:-}\"")"
  if [ -z "$value" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

render() {
  src="$1"
  dst="$2"
  mkdir -p "$(dirname "$dst")"
  sed \
    -e "s|__FREESWITCH_ESL_PASSWORD__|${FREESWITCH_ESL_PASSWORD}|g" \
    -e "s|__FREESWITCH_ESL_ACL__|${FREESWITCH_ESL_ACL}|g" \
    -e "s|__FREESWITCH_DOMAIN__|${FREESWITCH_DOMAIN}|g" \
    -e "s|__FREESWITCH_RTP_START_PORT__|${FREESWITCH_RTP_START_PORT}|g" \
    -e "s|__FREESWITCH_RTP_END_PORT__|${FREESWITCH_RTP_END_PORT}|g" \
    -e "s|__FREESWITCH_EXTERNAL_SIP_IP__|${FREESWITCH_EXTERNAL_SIP_IP}|g" \
    -e "s|__FREESWITCH_EXTERNAL_RTP_IP__|${FREESWITCH_EXTERNAL_RTP_IP}|g" \
    -e "s|__FREESWITCH_INTERNAL_SIP_PORT__|${FREESWITCH_INTERNAL_SIP_PORT}|g" \
    -e "s|__FREESWITCH_EXTERNAL_PROFILE_SIP_PORT__|${FREESWITCH_EXTERNAL_PROFILE_SIP_PORT}|g" \
    -e "s|__FREESWITCH_EXTERNAL_PROFILE_TLS_PORT__|${FREESWITCH_EXTERNAL_PROFILE_TLS_PORT}|g" \
    -e "s|__FREESWITCH_WEBRTC_WSS_PORT__|${FREESWITCH_WEBRTC_WSS_PORT}|g" \
    -e "s|__MAXO_TRUNK_MODE__|${MAXO_TRUNK_MODE}|g" \
    -e "s|__MAXO_SIP_PROXY__|${MAXO_SIP_PROXY}|g" \
    -e "s|__MAXO_SIP_REALM__|${MAXO_SIP_REALM}|g" \
    -e "s|__MAXO_OUTBOUND_PROXY__|${MAXO_OUTBOUND_PROXY}|g" \
    -e "s|__MAXO_USERNAME__|${MAXO_USERNAME}|g" \
    -e "s|__MAXO_PASSWORD__|${MAXO_PASSWORD}|g" \
    -e "s|__MAXO_CALLER_ID__|${MAXO_CALLER_ID}|g" \
    "$src" > "$dst"
}

required FREESWITCH_ESL_PASSWORD
required FREESWITCH_ESL_ACL
required FREESWITCH_DOMAIN
required FREESWITCH_RTP_START_PORT
required FREESWITCH_RTP_END_PORT
required FREESWITCH_EXTERNAL_SIP_IP
required FREESWITCH_EXTERNAL_RTP_IP
required FREESWITCH_INTERNAL_SIP_PORT
required FREESWITCH_EXTERNAL_PROFILE_SIP_PORT
required FREESWITCH_EXTERNAL_PROFILE_TLS_PORT
required FREESWITCH_WEBRTC_WSS_PORT

MAXO_TRUNK_MODE="${MAXO_TRUNK_MODE:-registration}"
MAXO_SIP_PROXY="${MAXO_SIP_PROXY:-}"
MAXO_SIP_REALM="${MAXO_SIP_REALM:-}"
MAXO_OUTBOUND_PROXY="${MAXO_OUTBOUND_PROXY:-}"
MAXO_USERNAME="${MAXO_USERNAME:-}"
MAXO_PASSWORD="${MAXO_PASSWORD:-}"
MAXO_CALLER_ID="${MAXO_CALLER_ID:-}"

mkdir -p "$GENERATED_DIR/directory/default"
mkdir -p "$LOG_DIR"
touch "$LOG_DIR/freeswitch.log"
mkdir -p "$DB_DIR"
mkdir -p "$CONFIG_DIR/autoload_configs"
mkdir -p "$CONFIG_DIR/dialplan/default"
mkdir -p "$CONFIG_DIR/sip_profiles/external"

# The base image ships vanilla internal profiles that bind 5060. This stack
# owns browser/agent registration through internal-webrtc, so disable the
# vanilla internal profiles to avoid host-mode port conflicts.
rm -f "$CONFIG_DIR/sip_profiles/internal.xml"
rm -f "$CONFIG_DIR/sip_profiles/internal-ipv6.xml"

rm -rf "$CONFIG_DIR/directory/default"
mkdir -p "$CONFIG_DIR/directory"
ln -s "$GENERATED_DIR/directory/default" "$CONFIG_DIR/directory/default"

render "$TEMPLATE_DIR/autoload_configs/event_socket.conf.xml.tpl" "$CONFIG_DIR/autoload_configs/event_socket.conf.xml"
render "$TEMPLATE_DIR/vars.xml.tpl" "$CONFIG_DIR/vars.xml"
render "$TEMPLATE_DIR/sip_profiles/internal-webrtc.xml.tpl" "$CONFIG_DIR/sip_profiles/internal-webrtc.xml"
render "$TEMPLATE_DIR/dialplan/default/outbound-maxo.xml.tpl" "$CONFIG_DIR/dialplan/default/outbound-maxo.xml"
render "$TEMPLATE_DIR/dialplan/default/voicemail-drop.xml.tpl" "$CONFIG_DIR/dialplan/default/voicemail-drop.xml"

if [ "${MAXO_TRUNK_MODE:-registration}" = "registration" ] && [ -n "${MAXO_SIP_PROXY:-}" ] && [ -n "${MAXO_USERNAME:-}" ]; then
  render "$TEMPLATE_DIR/sip_profiles/external/maxo-gateway.xml.tpl" "$CONFIG_DIR/sip_profiles/external/maxo-gateway.xml"
else
  rm -f "$CONFIG_DIR/sip_profiles/external/maxo-gateway.xml"
fi

if [ "${FREESWITCH_RENDER_ONLY:-false}" = "true" ]; then
  echo "FreeSWITCH config rendered into $CONFIG_DIR"
  exit 0
fi

exec freeswitch -nonat -nf -conf "$CONFIG_DIR" -log "$LOG_DIR" -db "$DB_DIR"
