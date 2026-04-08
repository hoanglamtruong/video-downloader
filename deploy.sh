#!/bin/bash
# =============================================================
# SnapSave - Auto Deploy Script
# =============================================================
# Cach dung:
#   Lan dau:  ./deploy.sh --setup
#   Lan sau:  ./deploy.sh
#   Chi dinh: ./deploy.sh user@ip
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.deploy.env"
REMOTE_DIR="/opt/snapsave"
APP_NAME="snapsave"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[*]${NC} $1"; }

# =============================================================
# Load or create config
# =============================================================
load_config() {
  if [[ -f "$ENV_FILE" ]]; then
    source "$ENV_FILE"
  fi
}

save_config() {
  cat > "$ENV_FILE" << EOF
SERVER_USER="$SERVER_USER"
SERVER_HOST="$SERVER_HOST"
SERVER_PORT="${SERVER_PORT:-22}"
DOMAIN="${DOMAIN:-}"
EOF
  chmod 600 "$ENV_FILE"
  log "Config saved to .deploy.env"
}

prompt_config() {
  echo ""
  echo -e "${CYAN}=== SnapSave Deploy Config ===${NC}"
  echo ""

  read -p "SSH User (default: root): " SERVER_USER
  SERVER_USER="${SERVER_USER:-root}"

  read -p "Server IP/Hostname: " SERVER_HOST
  [[ -z "$SERVER_HOST" ]] && err "Server IP is required"

  read -p "SSH Port (default: 22): " SERVER_PORT
  SERVER_PORT="${SERVER_PORT:-22}"

  read -p "Domain (bo trong neu dung IP): " DOMAIN

  save_config
}

SSH_CMD() {
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "${SERVER_PORT:-22}" "${SERVER_USER}@${SERVER_HOST}" "$@"
}

RSYNC_CMD() {
  rsync -avz --progress -e "ssh -p ${SERVER_PORT:-22}" "$@"
}

# =============================================================
# Check SSH connection
# =============================================================
check_ssh() {
  info "Checking SSH connection to ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}..."
  if SSH_CMD "echo ok" &>/dev/null; then
    log "SSH connection OK"
  else
    err "Cannot connect to ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}
  Make sure:
  1. Server is running
  2. SSH key is configured (ssh-copy-id ${SERVER_USER}@${SERVER_HOST})
  3. Port ${SERVER_PORT} is open"
  fi
}

# =============================================================
# First-time server setup
# =============================================================
setup_server() {
  info "Setting up server (first time)..."

  SSH_CMD bash << 'SETUP_EOF'
    set -e

    # --- Node.js ---
    if ! command -v node &>/dev/null; then
      echo "[*] Installing Node.js 20..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
    else
      echo "[OK] Node.js $(node -v)"
    fi

    # --- PM2 ---
    if ! command -v pm2 &>/dev/null; then
      echo "[*] Installing PM2..."
      npm install -g pm2
    else
      echo "[OK] PM2 installed"
    fi

    # --- Nginx ---
    if ! command -v nginx &>/dev/null; then
      echo "[*] Installing Nginx..."
      apt-get update && apt-get install -y nginx
    else
      echo "[OK] Nginx installed"
    fi

    # --- App directory ---
    mkdir -p /opt/snapsave/{logs,downloads,frames,bin}

    # --- PM2 startup ---
    pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true

    echo "[OK] Server setup complete"
SETUP_EOF

  log "Server setup done"
}

# =============================================================
# Configure Nginx
# =============================================================
setup_nginx() {
  info "Configuring Nginx..."

  local nginx_conf="$SCRIPT_DIR/nginx.conf"
  if [[ -n "$DOMAIN" ]]; then
    sed "s/server_name _;/server_name ${DOMAIN};/" "$nginx_conf" | \
      SSH_CMD "cat > /etc/nginx/sites-available/snapsave"
  else
    SSH_CMD "cat > /etc/nginx/sites-available/snapsave" < "$nginx_conf"
  fi

  SSH_CMD bash << 'NGINX_EOF'
    ln -sf /etc/nginx/sites-available/snapsave /etc/nginx/sites-enabled/snapsave
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
    echo "[OK] Nginx configured"
NGINX_EOF

  log "Nginx configured"
}

# =============================================================
# Deploy code
# =============================================================
deploy() {
  info "Deploying to ${SERVER_USER}@${SERVER_HOST}..."

  info "Syncing files..."
  RSYNC_CMD \
    --exclude 'node_modules/' \
    --exclude 'downloads/' \
    --exclude 'frames/' \
    --exclude 'logs/' \
    --exclude '.git/' \
    --exclude '.deploy.env' \
    "$SCRIPT_DIR/" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

  info "Installing dependencies and restarting..."
  SSH_CMD bash << EOF
    set -e
    cd $REMOTE_DIR

    mkdir -p logs downloads frames

    chmod +x bin/yt-dlp bin/ffmpeg bin/ffprobe 2>/dev/null || true

    npm install --omit=dev 2>&1 | tail -1

    if pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
      pm2 reload ecosystem.config.js --update-env
      echo "[OK] App reloaded"
    else
      pm2 start ecosystem.config.js
      pm2 save
      echo "[OK] App started"
    fi

    pm2 status $APP_NAME
EOF

  echo ""
  log "Deploy thanh cong!"
  echo ""
  if [[ -n "$DOMAIN" ]]; then
    echo -e "  ${CYAN}URL: http://${DOMAIN}${NC}"
  else
    echo -e "  ${CYAN}URL: http://${SERVER_HOST}${NC}"
    echo -e "  ${CYAN}URL: http://${SERVER_HOST}:3000${NC}"
  fi
  echo ""
}

# =============================================================
# Main
# =============================================================

case "${1:-}" in
  --setup)
    prompt_config
    check_ssh
    setup_server
    deploy
    setup_nginx
    log "Setup + Deploy hoan tat!"
    ;;

  --config)
    prompt_config
    ;;

  --nginx)
    load_config
    [[ -z "$SERVER_HOST" ]] && err "Chua config. Chay: ./deploy.sh --setup"
    check_ssh
    setup_nginx
    ;;

  --status)
    load_config
    [[ -z "$SERVER_HOST" ]] && err "Chua config. Chay: ./deploy.sh --setup"
    SSH_CMD "pm2 status $APP_NAME && echo '' && pm2 logs $APP_NAME --lines 10 --nostream"
    ;;

  --logs)
    load_config
    [[ -z "$SERVER_HOST" ]] && err "Chua config. Chay: ./deploy.sh --setup"
    SSH_CMD "pm2 logs $APP_NAME --lines 50"
    ;;

  --help|-h)
    echo "SnapSave Deploy Script"
    echo ""
    echo "Usage:"
    echo "  ./deploy.sh --setup     First-time setup + deploy"
    echo "  ./deploy.sh             Deploy (after setup)"
    echo "  ./deploy.sh --config    Update server config"
    echo "  ./deploy.sh --nginx     Reconfigure Nginx"
    echo "  ./deploy.sh --status    Check app status"
    echo "  ./deploy.sh --logs      View app logs"
    echo "  ./deploy.sh user@ip     Deploy to specific server"
    ;;

  "")
    load_config
    if [[ -z "$SERVER_HOST" ]]; then
      warn "Chua config server. Bat dau setup..."
      prompt_config
      check_ssh
      setup_server
      deploy
      setup_nginx
    else
      check_ssh
      deploy
    fi
    ;;

  *)
    if [[ "$1" == *@* ]]; then
      SERVER_USER="${1%%@*}"
      SERVER_HOST="${1##*@}"
      SERVER_PORT=22
      check_ssh
      deploy
    else
      err "Unknown option: $1. Use --help"
    fi
    ;;
esac
