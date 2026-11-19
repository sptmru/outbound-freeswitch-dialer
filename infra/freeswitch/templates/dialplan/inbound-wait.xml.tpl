<include>
  <context name="inbound-wait">
  <extension name="inbound-durable-wait">
    <condition field="destination_number" expression="^inbound_wait:([0-9a-f-]{36}):([0-9]{10,12}):(tone|/[A-Za-z0-9_./-]+)(:([0-9]{1,3}))?$">
      <!-- A native bridge can interrupt playback before changing the channel state. -->
      <action application="lua" data="$${conf_dir}/scripts/outbound-wait.lua $1 $2 $3 $5"/>
    </condition>
  </extension>
  </context>
</include>
