ARG FREESWITCH_BASE_IMAGE=safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6
FROM ${FREESWITCH_BASE_IMAGE}

COPY infra/freeswitch/entrypoint.sh /opt/outbound-dialer/entrypoint.sh
COPY infra/freeswitch/templates /opt/outbound-dialer/templates

RUN chmod +x /opt/outbound-dialer/entrypoint.sh

ENTRYPOINT ["/opt/outbound-dialer/entrypoint.sh"]
