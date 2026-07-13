upstream outbound_dialer_web {
  server web:80;
}

upstream outbound_dialer_api {
  server api:3000;
}

upstream outbound_dialer_freeswitch_ws {
  server ${FREESWITCH_WS_UPSTREAM};
}

upstream outbound_dialer_grafana {
  server grafana:3000;
}

map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

# Opaque media tickets are credentials. Keep their query strings out of the
# standard access log while retaining normal request logging everywhere else.
map $request_uri $outbound_dialer_access_loggable {
  default 1;
  ~^/api/admin/calls/[0-9a-f-]+/recording\? 0;
  ~^/api/admin/recordings/[0-9a-f-]+/audio\? 0;
}

server {
  listen 80;
  server_name ${LETSENCRYPT_DOMAIN};
  access_log /var/log/nginx/access.log combined if=$outbound_dialer_access_loggable;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 80;
  server_name ${GRAFANA_DOMAIN};

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 443 ssl;
  http2 on;
  server_name ${LETSENCRYPT_DOMAIN};
  access_log /var/log/nginx/access.log combined if=$outbound_dialer_access_loggable;

  ssl_certificate ${OUTBOUND_DIALER_SSL_CERTIFICATE};
  ssl_certificate_key ${OUTBOUND_DIALER_SSL_CERTIFICATE_KEY};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=(), geolocation=(), microphone=(self)" always;
  add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' wss:; img-src 'self' data:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'" always;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location /api/ {
    client_max_body_size ${PROXY_MAX_REQUEST_BODY_SIZE};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://outbound_dialer_api/;
  }

  location = /api/metrics {
    return 404;
  }

  location /freeswitch-ws {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;
    proxy_ssl_verify ${FREESWITCH_WS_UPSTREAM_TLS_VERIFY};
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_server_name on;
    proxy_ssl_name ${FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME};
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_pass ${FREESWITCH_WS_UPSTREAM_SCHEME}://outbound_dialer_freeswitch_ws/;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://outbound_dialer_web;
  }
}

server {
  listen 443 ssl;
  http2 on;
  server_name ${GRAFANA_DOMAIN};

  ssl_certificate ${OUTBOUND_DIALER_SSL_CERTIFICATE};
  ssl_certificate_key ${OUTBOUND_DIALER_SSL_CERTIFICATE_KEY};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_pass http://outbound_dialer_grafana;
  }
}
