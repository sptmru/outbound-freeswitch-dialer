<profile name="internal-webrtc">
  <settings>
    <param name="debug" value="0"/>
    <param name="sip-trace" value="no"/>
    <param name="sip-capture" value="no"/>
    <param name="rfc2833-pt" value="101"/>
    <param name="sip-port" value="__FREESWITCH_INTERNAL_SIP_PORT__"/>
    <param name="dialplan" value="XML"/>
    <param name="context" value="default"/>
    <param name="dtmf-duration" value="2000"/>
    <param name="inbound-codec-prefs" value="OPUS,PCMU,PCMA"/>
    <param name="outbound-codec-prefs" value="PCMU,PCMA,OPUS"/>
    <param name="rtp-ip" value="$${local_ip_v4}"/>
    <param name="sip-ip" value="$${local_ip_v4}"/>
    <param name="ext-rtp-ip" value="__FREESWITCH_EXTERNAL_RTP_IP__"/>
    <param name="ext-sip-ip" value="__FREESWITCH_EXTERNAL_SIP_IP__"/>
    <param name="tls" value="true"/>
    <param name="tls-bind-params" value="transport=tls"/>
    <param name="wss-binding" value=":__FREESWITCH_WEBRTC_WSS_PORT__"/>
    <param name="ws-binding" value=":5066"/>
    <param name="apply-inbound-acl" value="domains"/>
    <param name="auth-calls" value="true"/>
    <param name="accept-blind-reg" value="false"/>
    <param name="accept-blind-auth" value="false"/>
    <param name="manage-presence" value="false"/>
  </settings>
</profile>
