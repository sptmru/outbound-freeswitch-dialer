<include>
  <gateway name="maxo">
    <param name="username" value="__MAXO_USERNAME__"/>
    <param name="password" value="__MAXO_PASSWORD__"/>
    <param name="realm" value="__MAXO_SIP_REALM__"/>
    <param name="proxy" value="__MAXO_SIP_PROXY__"/>
    <param name="outbound-proxy" value="__MAXO_OUTBOUND_PROXY__"/>
    <param name="register" value="true"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="extension" value="__MAXO_USERNAME__"/>
    <param name="expire-seconds" value="300"/>
    <param name="retry-seconds" value="30"/>
  </gateway>
</include>
