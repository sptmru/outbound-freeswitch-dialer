FROM nginx:1.27-alpine

RUN apk add --no-cache ca-certificates openssl

COPY infra/proxy/entrypoint.sh /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh
COPY infra/proxy/nginx.conf.tpl /etc/nginx/templates/outbound-dialer.conf.tpl

RUN chmod +x /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh
