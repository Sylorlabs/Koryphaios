#!/bin/bash
# Koryphaios Relay — one-shot deploy to Hostodo VPS
# Usage: bash deploy.sh <server-ip> <root-password>
# Example: bash deploy.sh 158.51.125.29 'on-LhwYifiDr-hf|'

set -euo pipefail

SERVER="${1:-158.51.125.29}"
PASS="${2:-}"
RELAY_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$PASS" ]; then
  echo "Usage: bash deploy.sh <server-ip> <root-password>"
  exit 1
fi

SSH="sshpass -p $PASS ssh -o StrictHostKeyChecking=no root@$SERVER"
SCP="sshpass -p $PASS scp -o StrictHostKeyChecking=no"

echo "==> Testing connection..."
$SSH "echo 'SSH OK' && uname -a"

echo "==> Installing Bun on server..."
$SSH "curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun || true"

echo "==> Copying relay files..."
$SSH "mkdir -p /opt/koryphaios-relay"
$SCP "$RELAY_DIR/server.ts" "root@$SERVER:/opt/koryphaios-relay/server.ts"
$SCP "$RELAY_DIR/package.json" "root@$SERVER:/opt/koryphaios-relay/package.json"

echo "==> Generating secrets (if first deploy)..."
$SSH '
  SECRETS_FILE="/opt/koryphaios-relay/.env"
  if [ ! -f "$SECRETS_FILE" ]; then
    HOST_SECRET=$(openssl rand -hex 32)
    JWT_SECRET=$(openssl rand -hex 32)
    echo "HOST_SECRET=$HOST_SECRET" > "$SECRETS_FILE"
    echo "JWT_SECRET=$JWT_SECRET" >> "$SECRETS_FILE"
    echo "PORT=8080" >> "$SECRETS_FILE"
    echo "Created new secrets at $SECRETS_FILE"
  else
    echo "Secrets already exist, keeping them"
  fi
  cat "$SECRETS_FILE"
'

echo "==> Setting up systemd service..."
$SSH 'cat > /etc/systemd/system/koryphaios-relay.service << '\''EOF'\''
[Unit]
Description=Koryphaios Collaboration Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/koryphaios-relay
EnvironmentFile=/opt/koryphaios-relay/.env
ExecStart=/usr/local/bin/bun run server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

echo "==> Opening firewall port 8080..."
$SSH '
  # Allow port 8080 via iptables (Debian 12 default)
  iptables -C INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
  # Persist rules
  apt-get install -y -q iptables-persistent 2>/dev/null || true
  netfilter-persistent save 2>/dev/null || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
'

echo "==> Starting service..."
$SSH '
  systemctl daemon-reload
  systemctl enable koryphaios-relay
  systemctl restart koryphaios-relay
  sleep 2
  systemctl status koryphaios-relay --no-pager
'

echo "==> Getting secrets for Koryphaios config..."
SECRETS=$($SSH "cat /opt/koryphaios-relay/.env")
HOST_SECRET=$(echo "$SECRETS" | grep HOST_SECRET | cut -d= -f2)

echo ""
echo "======================================================"
echo "  RELAY DEPLOYED SUCCESSFULLY"
echo "======================================================"
echo "  Relay URL:   http://$SERVER:8080"
echo "  Health:      http://$SERVER:8080/health"
echo "  HOST_SECRET: $HOST_SECRET"
echo ""
echo "  Add this to your Koryphaios .env or koryphaios.json:"
echo "    RELAY_URL=http://$SERVER:8080"
echo "    RELAY_HOST_SECRET=$HOST_SECRET"
echo "======================================================"
