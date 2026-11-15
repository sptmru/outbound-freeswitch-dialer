<include>
  <!-- One durable uuid_transfer carries the server-selected immutable snapshot.
       No preceding setvar commands can be stranded by a lost response. -->
  <extension name="voicemail-native-drop">
    <condition field="destination_number" expression="^voicemail_native:([0-9a-fA-F-]{36}):(/[A-Za-z0-9_./-]+)$">
      <action application="set" data="voicemail_drop_call_id=$1"/>
      <action application="set" data="voicemail_drop_file=$2"/>
      <action application="transfer" data="voicemail_drop XML default"/>
    </condition>
  </extension>
  <extension name="voicemail-drop">
    <condition field="destination_number" expression="^voicemail_drop$">
      <action application="answer"/>
      <action application="event" data="Event-Name=CUSTOM,Event-Subclass=outbound_dialer::voicemail_playback_started,Outbound-Dialer-Call-ID=${voicemail_drop_call_id},Outbound-Dialer-Customer-Leg-UUID=${uuid}"/>
      <action application="playback" data="${voicemail_drop_file}"/>
      <action application="transfer" data="voicemail_drop_result XML default"/>
    </condition>
  </extension>

  <extension name="voicemail-drop-result">
    <condition field="destination_number" expression="^voicemail_drop_result$"/>
    <condition field="${playback_ms}" expression="^[1-9][0-9]*$">
      <action application="event" data="Event-Name=CUSTOM,Event-Subclass=outbound_dialer::voicemail_playback_completed,Outbound-Dialer-Call-ID=${voicemail_drop_call_id},Outbound-Dialer-Customer-Leg-UUID=${uuid},Playback-Milliseconds=${playback_ms}"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
      <anti-action application="event" data="Event-Name=CUSTOM,Event-Subclass=outbound_dialer::voicemail_playback_failed,Outbound-Dialer-Call-ID=${voicemail_drop_call_id},Outbound-Dialer-Customer-Leg-UUID=${uuid},Playback-Milliseconds=${playback_ms}"/>
      <anti-action application="hangup" data="NORMAL_TEMPORARY_FAILURE"/>
    </condition>
  </extension>
</include>
