<include>
  <context name="inbound-wait">
  <extension name="inbound-durable-wait">
    <condition field="destination_number" expression="^inbound_wait:([0-9a-f-]{36}):([0-9]{10,12}):(tone|/[A-Za-z0-9_./-]+)$">
      <action application="lua" data="$${conf_dir}/scripts/outbound-wait.lua $1 $2 $3"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
    </condition>
  </extension>
  </context>
</include>
