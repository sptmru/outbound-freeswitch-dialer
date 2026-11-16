<include>
  <context name="inbound-forward">
    <extension name="inbound-reserved-forward">
      <condition field="destination_number" expression="^inbound_forward:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9]{10,12}):([0-9]{10,12}):(\+[1-9][0-9]{6,14}):(sofia/.+)$">
        <action application="lua" data="$${conf_dir}/scripts/outbound-forward.lua $1 $2 $3 $4 $5 $6"/>
      </condition>
    </extension>
    <extension name="reject"><condition><action application="hangup" data="CALL_REJECTED"/></condition></extension>
  </context>
</include>
