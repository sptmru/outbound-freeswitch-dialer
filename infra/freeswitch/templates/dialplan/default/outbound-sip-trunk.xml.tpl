<include>
  <extension name="outbound-sip-trunk-registration">
    <condition field="${outbound_trunk_mode}" expression="^registration$"/>
    <condition field="destination_number" expression="^\+?([0-9]{7,15})$">
      <action application="set" data="effective_caller_id_number=${outbound_caller_id}"/>
      <action application="bridge" data="sofia/gateway/sip-trunk/$1"/>
    </condition>
  </extension>

  <extension name="outbound-sip-trunk-ip-auth">
    <condition field="${outbound_trunk_mode}" expression="^ip_auth$"/>
    <condition field="destination_number" expression="^\+?([0-9]{7,15})$">
      <action application="set" data="effective_caller_id_number=${outbound_caller_id}"/>
      <action application="bridge" data="sofia/external/$1@${outbound_sip_proxy}"/>
    </condition>
  </extension>
</include>
