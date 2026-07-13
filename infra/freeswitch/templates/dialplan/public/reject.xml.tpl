<include>
  <extension name="deny-unsolicited-inbound-calls">
    <condition field="destination_number" expression="^.*$">
      <action application="respond" data="403 Inbound calling is not enabled"/>
      <action application="hangup" data="CALL_REJECTED"/>
    </condition>
  </extension>
</include>
