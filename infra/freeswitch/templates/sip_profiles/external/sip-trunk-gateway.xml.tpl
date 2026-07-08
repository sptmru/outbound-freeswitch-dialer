<include>
  <gateway name="sip-trunk">
    <param name="username" value="__SIP_TRUNK_USERNAME__"/>
    <param name="password" value="__SIP_TRUNK_PASSWORD__"/>
    <param name="realm" value="__SIP_TRUNK_REALM__"/>
    <param name="proxy" value="__SIP_TRUNK_PROXY__"/>
    <param name="outbound-proxy" value="__SIP_TRUNK_OUTBOUND_PROXY__"/>
    <param name="register" value="true"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="extension" value="__SIP_TRUNK_USERNAME__"/>
    <param name="expire-seconds" value="300"/>
    <param name="retry-seconds" value="30"/>
  </gateway>
</include>
