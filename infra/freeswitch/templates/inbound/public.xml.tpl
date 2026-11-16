<include>
  <extension name="d02_revision___HASH__" continue="true"><condition>
    <action application="unset" data="outbound_dialer_call_id"/>
    <action application="unset" data="outbound_dialer_operation_id"/>
    <action application="unset" data="outbound_dialer_supervisor_session_id"/>
    <action application="unset" data="outbound_dialer_leg_type"/>
  </condition></extension>
  <extension name="d02_transport" continue="true"><condition field="__TRUST__" expression="(^|:)true(:|$)">
    <anti-action application="respond" data="403 Untrusted ingress"/>
    <anti-action application="hangup" data="CALL_REJECTED"/>
  </condition></extension>
__ROUTES__
  <extension name="d02_unknown"><condition>
    <action application="respond" data="404 Unknown DID"/>
    <action application="hangup" data="UNALLOCATED_NUMBER"/>
  </condition></extension>
</include>
