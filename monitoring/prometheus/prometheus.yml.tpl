global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]

  - job_name: outbound-dialer-api
    scrape_interval: 3s
    scrape_timeout: 2s
    metrics_path: /metrics
    static_configs:
      - targets: ["api:3000"]

  - job_name: node-exporter
    static_configs:
      - targets: ["node-exporter:9100"]

  - job_name: cadvisor
    static_configs:
      - targets: ["cadvisor:8080"]

  - job_name: postgres-exporter
    static_configs:
      - targets: ["postgres-exporter:9187"]

  - job_name: alertmanager
    static_configs:
      - targets: ["alertmanager:9093"]

  - job_name: loki
    static_configs:
      - targets: ["loki:3100"]

  - job_name: alloy
    static_configs:
      - targets: ["alloy:12345"]

  - job_name: grafana
    static_configs:
      - targets: ["grafana:3000"]

  - job_name: blackbox-http
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - __APP_READY_URL__
          - __GRAFANA_HEALTH_URL__
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
