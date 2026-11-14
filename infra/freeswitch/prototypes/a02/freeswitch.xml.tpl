<?xml version="1.0"?>
<!-- A02 ONLY. Isolated net namespace; never included by the product entrypoint. -->
<document type="freeswitch/xml">
  <section name="configuration">
    <configuration name="modules.conf"><modules>
      <load module="mod_console"/>
      <load module="mod_event_socket"/>
      <load module="mod_sofia"/>
      <load module="mod_dialplan_xml"/>
      <load module="mod_dptools"/>
      <load module="mod_commands"/>
      <load module="mod_tone_stream"/>
    </modules></configuration>
    <configuration name="switch.conf"><settings>
      <param name="max-sessions" value="8"/>
      <param name="sessions-per-second" value="8"/>
      <param name="rtp-start-port" value="20000"/>
      <param name="rtp-end-port" value="20020"/>
    </settings></configuration>
    <configuration name="console.conf"><settings><param name="loglevel" value="warning"/></settings></configuration>
    <configuration name="event_socket.conf"><settings>
      <param name="listen-ip" value="127.0.0.1"/>
      <param name="listen-port" value="8021"/>
      <param name="password" value="a02-disposable-only"/>
    </settings></configuration>
    <configuration name="sofia.conf"><profiles><profile name="a02-loopback">
      <settings>
        <param name="sip-ip" value="127.0.0.1"/>
        <param name="rtp-ip" value="127.0.0.1"/>
        <param name="rtp-timer-name" value="soft"/>
        <param name="sip-port" value="5080"/>
        <param name="dialplan" value="XML"/>
        <param name="context" value="a02-ingress"/>
        <param name="auth-calls" value="false"/>
        <param name="disable-register" value="true"/>
        <param name="manage-presence" value="false"/>
        <param name="inbound-codec-prefs" value="PCMU,PCMA"/>
        <param name="outbound-codec-prefs" value="PCMU,PCMA"/>
        <param name="inbound-late-negotiation" value="false"/>
        <param name="enable-timer" value="false"/>
        <param name="sip-trace" value="no"/>
      </settings>
    </profile></profiles></configuration>
  </section>
  <section name="dialplan"><context name="a02-ingress">
    <!-- No SIP header is ever copied to product authority fields. No DB/API runs. -->
    <extension name="clear-product-authority" continue="true"><condition>
      <action application="unset" data="outbound_dialer_call_id"/>
      <action application="unset" data="outbound_dialer_operation_id"/>
      <action application="unset" data="outbound_dialer_supervisor_session_id"/>
      <action application="unset" data="outbound_dialer_leg_type"/>
    </condition></extension>
    <extension name="reject-untrusted" continue="true"><condition field="network_addr" expression="^127\.0\.0\.2$">
      <anti-action application="respond" data="403 Untrusted ingress"/>
      <anti-action application="hangup" data="CALL_REJECTED"/>
    </condition></extension>
    <extension name="reject-disabled"><condition field="destination_number" expression="^\+?12025550101$">
      <action application="respond" data="403 DID disabled"/>
      <action application="hangup" data="CALL_REJECTED"/>
    </condition></extension>
    <!-- Lab normalization only: optional plus for this single fixed NANP DID. -->
    <extension name="known-enabled-did"><condition field="destination_number" expression="^\+?12025550100$">
      <action application="set" data="a02_ingress_uuid=${uuid}"/>
      <action application="set" data="a02_validated_did=+12025550100"/>
      <action application="set" data="a02_route_revision=fixture-v1"/>
      <action application="event" data="Event-Name=CUSTOM,Event-Subclass=outbound_dialer::a02_validated,A02-Ingress-UUID=${a02_ingress_uuid},A02-DID=${a02_validated_did},A02-Route-Revision=${a02_route_revision}"/>
      __A02_ACTIONS__
    </condition></extension>
    <extension name="reject-unknown"><condition>
      <action application="respond" data="404 Unknown DID"/>
      <action application="hangup" data="UNALLOCATED_NUMBER"/>
    </condition></extension>
  </context></section>
</document>
