ARG FREESWITCH_BUILD_IMAGE=signalwire/freeswitch-public-base@sha256:790ee70a1ae2725297ff00f5137acd93943267c242948af19799a9df325d767d
ARG FREESWITCH_SOURCE_COMMIT=a88d069d6ffb74df797bcaf001f7e63181c07a09
ARG FREESWITCH_BASE_IMAGE=safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6

FROM ${FREESWITCH_BUILD_IMAGE} AS avmd-builder

ARG FREESWITCH_SOURCE_COMMIT

RUN git clone --filter=blob:none --no-checkout https://github.com/signalwire/freeswitch.git /usr/src/freeswitch \
    && git -C /usr/src/freeswitch checkout "${FREESWITCH_SOURCE_COMMIT}"

WORKDIR /usr/src/freeswitch

RUN ./bootstrap.sh -j

RUN ./configure --disable-dependency-tracking

RUN make src/include/switch_version.h \
    && make -j2 libfreeswitch.la

COPY infra/freeswitch/patches/mod_avmd-use-actual-sample-rate.patch /tmp/mod_avmd-use-actual-sample-rate.patch

RUN patch -p1 < /tmp/mod_avmd-use-actual-sample-rate.patch

RUN make -C src/mod/applications/mod_avmd mod_avmd.la

FROM ${FREESWITCH_BASE_IMAGE}

COPY --from=avmd-builder /usr/src/freeswitch/src/mod/applications/mod_avmd/.libs/mod_avmd.so /usr/lib/freeswitch/mod/mod_avmd.so

COPY infra/freeswitch/entrypoint.sh /opt/outbound-dialer/entrypoint.sh
COPY infra/freeswitch/templates /opt/outbound-dialer/templates

RUN chmod +x /opt/outbound-dialer/entrypoint.sh

ENTRYPOINT ["/opt/outbound-dialer/entrypoint.sh"]
