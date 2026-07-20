<configuration name="avmd.conf" description="AVMD config">
  <settings>
    <!-- Outbound dialer tuning surface for FreeSWITCH mod_avmd voicemail beep detection. -->

    <!-- Global settings -->
    <param name="debug" value="0"/>
    <param name="report_status" value="1"/>
    <param name="fast_math" value="0"/>

    <!-- Per-call settings. These can also be overwritten dynamically per AVMD session. -->
    <param name="require_continuous_streak" value="1"/>
    <param name="sample_n_continuous_streak" value="3"/>
    <param name="sample_n_to_skip" value="0"/>
    <param name="require_continuous_streak_amp" value="1"/>
    <param name="sample_n_continuous_streak_amp" value="3"/>
    <param name="simplified_estimation" value="1"/>
    <param name="inbound_channel" value="1"/>
    <param name="outbound_channel" value="1"/>
    <param name="detection_mode" value="2"/>
    <param name="detectors_n" value="36"/>
    <param name="detectors_lagged_n" value="1"/>
  </settings>
</configuration>
