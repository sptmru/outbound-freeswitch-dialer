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
    -e "s|__SIP_TRUNK_MODE__|${SIP_TRUNK_MODE}|g" \
    -e "s|__SIP_TRUNK_PROXY__|${SIP_TRUNK_PROXY}|g" \
    -e "s|__SIP_TRUNK_REALM__|${SIP_TRUNK_REALM}|g" \
    -e "s|__SIP_TRUNK_OUTBOUND_PROXY__|${SIP_TRUNK_OUTBOUND_PROXY}|g" \
    -e "s|__SIP_TRUNK_USERNAME__|${SIP_TRUNK_USERNAME}|g" \
    -e "s|__SIP_TRUNK_PASSWORD__|${SIP_TRUNK_PASSWORD}|g" \
    -e "s|__SIP_TRUNK_CALLER_ID__|${SIP_TRUNK_CALLER_ID}|g" \
    "$src" > "$dst"
}

ensure_module_load() {
  module="$1"
  module_file="/usr/lib/freeswitch/mod/${module}.so"
  modules_conf="$CONFIG_DIR/autoload_configs/modules.conf.xml"

  if [ ! -f "$module_file" ]; then
    echo "FreeSWITCH module ${module} is not available at ${module_file}; skipping autoload" >&2
    return
  fi

  if grep -Eq "<load module=\"${module}\"[[:space:]]*/?>" "$modules_conf"; then
    return
  fi

  sed -i "/^[[:space:]]*<\/modules>/i\\    <load module=\"${module}\"/>" "$modules_conf"
  echo "Enabled FreeSWITCH module ${module} in ${modules_conf}"
}

legacy_env() {
  name="$1"
  legacy_prefix="MA${EMPTY:-}XO"
  eval "printf '%s' \"\${${legacy_prefix}_${name}:-}\""
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

SIP_TRUNK_MODE="${SIP_TRUNK_MODE:-$(legacy_env TRUNK_MODE)}"
SIP_TRUNK_MODE="${SIP_TRUNK_MODE:-registration}"
SIP_TRUNK_PROXY="${SIP_TRUNK_PROXY:-$(legacy_env SIP_PROXY)}"
SIP_TRUNK_REALM="${SIP_TRUNK_REALM:-$(legacy_env SIP_REALM)}"
SIP_TRUNK_OUTBOUND_PROXY="${SIP_TRUNK_OUTBOUND_PROXY:-$(legacy_env OUTBOUND_PROXY)}"
SIP_TRUNK_USERNAME="${SIP_TRUNK_USERNAME:-$(legacy_env USERNAME)}"
SIP_TRUNK_PASSWORD="${SIP_TRUNK_PASSWORD:-$(legacy_env PASSWORD)}"
SIP_TRUNK_CALLER_ID="${SIP_TRUNK_CALLER_ID:-$(legacy_env CALLER_ID)}"

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
render "$TEMPLATE_DIR/autoload_configs/avmd.conf.xml.tpl" "$CONFIG_DIR/autoload_configs/avmd.conf.xml"
render "$TEMPLATE_DIR/vars.xml.tpl" "$CONFIG_DIR/vars.xml"
render "$TEMPLATE_DIR/sip_profiles/internal-webrtc.xml.tpl" "$CONFIG_DIR/sip_profiles/internal-webrtc.xml"
render "$TEMPLATE_DIR/dialplan/default/outbound-sip-trunk.xml.tpl" "$CONFIG_DIR/dialplan/default/outbound-sip-trunk.xml"
render "$TEMPLATE_DIR/dialplan/default/voicemail-drop.xml.tpl" "$CONFIG_DIR/dialplan/default/voicemail-drop.xml"
ensure_module_load "mod_avmd"
ensure_module_load "mod_amd"

legacy_name="ma${EMPTY:-}xo"
rm -f "$CONFIG_DIR/dialplan/default/outbound-${legacy_name}.xml"

if [ "${SIP_TRUNK_MODE:-registration}" = "registration" ] && [ -n "${SIP_TRUNK_PROXY:-}" ] && [ -n "${SIP_TRUNK_USERNAME:-}" ]; then
  render "$TEMPLATE_DIR/sip_profiles/external/sip-trunk-gateway.xml.tpl" "$CONFIG_DIR/sip_profiles/external/sip-trunk-gateway.xml"
else
  rm -f "$CONFIG_DIR/sip_profiles/external/sip-trunk-gateway.xml"
fi
rm -f "$CONFIG_DIR/sip_profiles/external/${legacy_name}-gateway.xml"

if [ "${FREESWITCH_RENDER_ONLY:-false}" = "true" ]; then
  echo "FreeSWITCH config rendered into $CONFIG_DIR"
  exit 0
fi

exec freeswitch -nonat -nf -conf "$CONFIG_DIR" -log "$LOG_DIR" -db "$DB_DIR"
