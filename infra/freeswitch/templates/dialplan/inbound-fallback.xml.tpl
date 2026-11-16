<include>
  <context name="inbound-fallback">
    <extension name="inbound-durable-fallback">
      <condition field="destination_number" expression="^inbound_fallback:([0-9a-f-]{36}):([0-9]{10,12}):(/[A-Za-z0-9_./-]+)$">
        <action application="lua" data="$${conf_dir}/scripts/outbound-fallback.lua $1 $2 $3"/>
        <action application="hangup" data="NORMAL_CLEARING"/>
      </condition>
    </extension>
  </context>
</include>
