<include>
  <extension name="deny-agent-originated-calls">
    <condition field="destination_number" expression="^.*$">
      <action application="respond" data="403 Backend call control required"/>
      <action application="hangup" data="CALL_REJECTED"/>
    </condition>
  </extension>
</include>
