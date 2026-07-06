ARG FREESWITCH_BASE_IMAGE=safarov/freeswitch:latest
FROM ${FREESWITCH_BASE_IMAGE}

COPY infra/freeswitch/entrypoint.sh /opt/outbound-dialer/entrypoint.sh
COPY infra/freeswitch/templates /opt/outbound-dialer/templates

RUN chmod +x /opt/outbound-dialer/entrypoint.sh

ENTRYPOINT ["/opt/outbound-dialer/entrypoint.sh"]
