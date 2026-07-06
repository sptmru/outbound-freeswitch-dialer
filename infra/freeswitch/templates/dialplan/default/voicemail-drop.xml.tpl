<include>
  <extension name="voicemail-drop">
    <condition field="destination_number" expression="^voicemail_drop$">
      <action application="answer"/>
      <action application="playback" data="${voicemail_drop_file}"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
    </condition>
  </extension>
</include>
