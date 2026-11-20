#!/usr/bin/env bash
# 沒有網域時，為裸 IP 產生一張自簽憑證給 Caddy 用。
#   bash deploy/make-selfsigned.sh 203.0.113.10
# 重複執行會覆寫；有效期限 397 天（瀏覽器對憑證的實務上限）。
set -euo pipefail

IP="${1:-}"
if [[ -z "$IP" ]]; then
  echo "用法：bash deploy/make-selfsigned.sh <公網IP> [第二個IP...]" >&2
  exit 1
fi
shift || true

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$DIR"

SAN="IP:${IP}"
for extra in "$@"; do SAN="${SAN},IP:${extra}"; done

openssl req -x509 -newkey rsa:2048 -nodes -days 397 \
  -keyout "$DIR/triplog.key" -out "$DIR/triplog.crt" \
  -subj "/CN=${IP}/O=TripLog Local" \
  -addext "subjectAltName=${SAN}" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "basicConstraints=critical,CA:FALSE"

chmod 600 "$DIR/triplog.key" "$DIR/triplog.crt"

echo "已產生 $DIR/triplog.crt、triplog.key（SAN: ${SAN}）"
echo "接著：echo 'TRIPLOG_IP=${IP}' >> .env && docker compose -f docker-compose.yml -f deploy/compose.selfsigned.yml --profile tls up -d"
