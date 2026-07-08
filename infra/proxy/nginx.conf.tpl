upstream outbound_dialer_web {
  server web:80;
}

upstream outbound_dialer_api {
  server api:3000;
}

upstream outbound_dialer_freeswitch_ws {
  server ${FREESWITCH_WS_UPSTREAM};
}

server {
  listen 80;
  server_name ${LETSENCRYPT_DOMAIN};

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

  ssl_certificate ${OUTBOUND_DIALER_SSL_CERTIFICATE};
  ssl_certificate_key ${OUTBOUND_DIALER_SSL_CERTIFICATE_KEY};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://outbound_dialer_api/;
  }

  location /freeswitch-ws {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;
    proxy_ssl_verify off;
    proxy_ssl_server_name on;
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
