<include>
  <extension name="outbound-maxo-registration">
    <condition field="${outbound_trunk_mode}" expression="^registration$"/>
    <condition field="destination_number" expression="^\+?([0-9]{7,15})$">
      <action application="set" data="effective_caller_id_number=${outbound_caller_id}"/>
      <action application="bridge" data="sofia/gateway/maxo/$1"/>
    </condition>
  </extension>

  <extension name="outbound-maxo-ip-auth">
    <condition field="${outbound_trunk_mode}" expression="^ip_auth$"/>
    <condition field="destination_number" expression="^\+?([0-9]{7,15})$">
      <action application="set" data="effective_caller_id_number=${outbound_caller_id}"/>
      <action application="bridge" data="sofia/external/$1@${outbound_sip_proxy}"/>
    </condition>
  </extension>
</include>
