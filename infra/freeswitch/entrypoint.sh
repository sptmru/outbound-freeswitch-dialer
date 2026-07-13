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

escape_xml_for_sed() {
  value="$1"
  carriage_return="$(printf '\r')"
  case "$value" in
    *"
"*|*"$carriage_return"*)
      echo "FreeSWITCH configuration values must be single-line strings" >&2
      return 1
      ;;
  esac
  printf '%s' "$value" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g" \
    | sed -e 's/[\\&|]/\\&/g'
}

render() {
  src="$1"
  dst="$2"
  mkdir -p "$(dirname "$dst")"
  esl_password="$(escape_xml_for_sed "$FREESWITCH_ESL_PASSWORD")"
  esl_acl="$(escape_xml_for_sed "$FREESWITCH_ESL_ACL")"
  domain="$(escape_xml_for_sed "$FREESWITCH_DOMAIN")"
  rtp_start="$(escape_xml_for_sed "$FREESWITCH_RTP_START_PORT")"
  rtp_end="$(escape_xml_for_sed "$FREESWITCH_RTP_END_PORT")"
  external_sip_ip="$(escape_xml_for_sed "$FREESWITCH_EXTERNAL_SIP_IP")"
  external_rtp_ip="$(escape_xml_for_sed "$FREESWITCH_EXTERNAL_RTP_IP")"
  internal_sip_port="$(escape_xml_for_sed "$FREESWITCH_INTERNAL_SIP_PORT")"
  external_sip_port="$(escape_xml_for_sed "$FREESWITCH_EXTERNAL_PROFILE_SIP_PORT")"
  external_tls_port="$(escape_xml_for_sed "$FREESWITCH_EXTERNAL_PROFILE_TLS_PORT")"
  webrtc_wss_port="$(escape_xml_for_sed "$FREESWITCH_WEBRTC_WSS_PORT")"
  trunk_mode="$(escape_xml_for_sed "$SIP_TRUNK_MODE")"
  trunk_proxy="$(escape_xml_for_sed "$SIP_TRUNK_PROXY")"
  trunk_realm="$(escape_xml_for_sed "$SIP_TRUNK_REALM")"
  trunk_outbound_proxy="$(escape_xml_for_sed "$SIP_TRUNK_OUTBOUND_PROXY")"
  trunk_username="$(escape_xml_for_sed "$SIP_TRUNK_USERNAME")"
  trunk_password="$(escape_xml_for_sed "$SIP_TRUNK_PASSWORD")"
  trunk_caller_id="$(escape_xml_for_sed "$SIP_TRUNK_CALLER_ID")"
  sed \
    -e "s|__FREESWITCH_ESL_PASSWORD__|${esl_password}|g" \
    -e "s|__FREESWITCH_ESL_ACL__|${esl_acl}|g" \
    -e "s|__FREESWITCH_DOMAIN__|${domain}|g" \
    -e "s|__FREESWITCH_RTP_START_PORT__|${rtp_start}|g" \
    -e "s|__FREESWITCH_RTP_END_PORT__|${rtp_end}|g" \
    -e "s|__FREESWITCH_EXTERNAL_SIP_IP__|${external_sip_ip}|g" \
    -e "s|__FREESWITCH_EXTERNAL_RTP_IP__|${external_rtp_ip}|g" \
    -e "s|__FREESWITCH_INTERNAL_SIP_PORT__|${internal_sip_port}|g" \
    -e "s|__FREESWITCH_EXTERNAL_PROFILE_SIP_PORT__|${external_sip_port}|g" \
    -e "s|__FREESWITCH_EXTERNAL_PROFILE_TLS_PORT__|${external_tls_port}|g" \
    -e "s|__FREESWITCH_WEBRTC_WSS_PORT__|${webrtc_wss_port}|g" \
    -e "s|__SIP_TRUNK_MODE__|${trunk_mode}|g" \
    -e "s|__SIP_TRUNK_PROXY__|${trunk_proxy}|g" \
    -e "s|__SIP_TRUNK_REALM__|${trunk_realm}|g" \
    -e "s|__SIP_TRUNK_OUTBOUND_PROXY__|${trunk_outbound_proxy}|g" \
    -e "s|__SIP_TRUNK_USERNAME__|${trunk_username}|g" \
    -e "s|__SIP_TRUNK_PASSWORD__|${trunk_password}|g" \
    -e "s|__SIP_TRUNK_CALLER_ID__|${trunk_caller_id}|g" \
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

disable_module_load() {
  module="$1"
  modules_conf="$CONFIG_DIR/autoload_configs/modules.conf.xml"

  if ! grep -Eq "<load module=\"${module}\"[[:space:]]*/?>" "$modules_conf"; then
    return
  fi

  sed -i "/<load module=\"${module}\"[[:space:]]*\/>/d" "$modules_conf"
  echo "Disabled unused FreeSWITCH module ${module} in ${modules_conf}"
}

configure_rtp_port_range() {
  switch_conf="$CONFIG_DIR/autoload_configs/switch.conf.xml"
  rtp_start="$(escape_xml_for_sed "$FREESWITCH_RTP_START_PORT")"
  rtp_end="$(escape_xml_for_sed "$FREESWITCH_RTP_END_PORT")"

  # rtp_start_port/rtp_end_port in vars.xml are convenient dialplan variables,
  # but the core RTP allocator reads these switch.conf.xml parameters.
  sed -i \
    -e "/<param name=\"rtp-start-port\"/c\\    <param name=\"rtp-start-port\" value=\"${rtp_start}\"/>" \
    -e "/<param name=\"rtp-end-port\"/c\\    <param name=\"rtp-end-port\" value=\"${rtp_end}\"/>" \
    "$switch_conf"

  grep -Fq "<param name=\"rtp-start-port\" value=\"${FREESWITCH_RTP_START_PORT}\"/>" "$switch_conf"
  grep -Fq "<param name=\"rtp-end-port\" value=\"${FREESWITCH_RTP_END_PORT}\"/>" "$switch_conf"
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
mkdir -p "$CONFIG_DIR/sip_profiles/external"

# The base image ships vanilla internal profiles that bind 5060. This stack
# owns browser/agent registration through internal-webrtc, so disable the
# vanilla internal profiles to avoid host-mode port conflicts.
rm -f "$CONFIG_DIR/sip_profiles/internal.xml"
rm -f "$CONFIG_DIR/sip_profiles/internal-ipv6.xml"

# This is an outbound-only control plane. Remove the base image's callable
# default/public extensions so authenticated browser agents and inbound trunk
# traffic cannot reach PSTN/features outside backend-owned ESL originate.
rm -rf "$CONFIG_DIR/dialplan/default" "$CONFIG_DIR/dialplan/agent-ingress" "$CONFIG_DIR/dialplan/public"
mkdir -p "$CONFIG_DIR/dialplan/default" "$CONFIG_DIR/dialplan/agent-ingress" "$CONFIG_DIR/dialplan/public"

rm -rf "$CONFIG_DIR/directory/default"
mkdir -p "$CONFIG_DIR/directory"
ln -s "$GENERATED_DIR/directory/default" "$CONFIG_DIR/directory/default"

render "$TEMPLATE_DIR/autoload_configs/event_socket.conf.xml.tpl" "$CONFIG_DIR/autoload_configs/event_socket.conf.xml"
render "$TEMPLATE_DIR/autoload_configs/avmd.conf.xml.tpl" "$CONFIG_DIR/autoload_configs/avmd.conf.xml"
render "$TEMPLATE_DIR/vars.xml.tpl" "$CONFIG_DIR/vars.xml"
render "$TEMPLATE_DIR/sip_profiles/internal-webrtc.xml.tpl" "$CONFIG_DIR/sip_profiles/internal-webrtc.xml"
render "$TEMPLATE_DIR/dialplan/default/voicemail-drop.xml.tpl" "$CONFIG_DIR/dialplan/default/voicemail-drop.xml"
render "$TEMPLATE_DIR/dialplan/agent-ingress/reject.xml.tpl" "$CONFIG_DIR/dialplan/agent-ingress/reject.xml"
render "$TEMPLATE_DIR/dialplan/public/reject.xml.tpl" "$CONFIG_DIR/dialplan/public/reject.xml"
configure_rtp_port_range
ensure_module_load "mod_avmd"
ensure_module_load "mod_amd"
disable_module_load "mod_signalwire"

legacy_name="ma${EMPTY:-}xo"

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
