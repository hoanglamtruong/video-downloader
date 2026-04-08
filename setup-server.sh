#!/bin/bash
# =============================================================
# SnapSave - Server Setup Script (chạy 1 lần trên server)
# Dùng: sudo bash setup-server.sh
# =============================================================

set -e

APP_DIR="/opt/snapsave"
APP_NAME="snapsave"
APP_USER="www-data"

echo "🔧 Setting up SnapSave server..."

# --- 1. Cài Node.js (nếu chưa có) ---
if ! command -v node &>/dev/null; then
  echo "📥 Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "✅ Node.js $(node -v) already installed"
fi

# --- 2. Cài PM2 ---
if ! command -v pm2 &>/dev/null; then
  echo "📥 Installing PM2..."
  npm install -g pm2
else
  echo "✅ PM2 already installed"
fi

# --- 3. Cài Nginx ---
if ! command -v nginx &>/dev/null; then
  echo "📥 Installing Nginx..."
  apt-get update && apt-get install -y nginx
else
  echo "✅ Nginx already installed"
fi

# --- 4. Tạo thư mục app ---
echo "📁 Creating app directory at $APP_DIR..."
mkdir -p "$APP_DIR"/{logs,downloads,frames}

# --- 5. Cấu hình Nginx ---
echo "⚙️  Configuring Nginx..."
cp "$APP_DIR/nginx.conf" /etc/nginx/sites-available/snapsave
ln -sf /etc/nginx/sites-available/snapsave /etc/nginx/sites-enabled/snapsave
rm -f /etc/nginx/sites-enabled/default  # Bỏ default site

nginx -t && systemctl reload nginx
echo "✅ Nginx configured"

# --- 6. PM2 startup (tự khởi động khi server reboot) ---
echo "⚙️  Setting up PM2 startup..."
pm2 startup systemd -u $USER --hp $HOME | tail -1 | bash || true

echo ""
echo "✅ Server setup hoàn tất!"
echo "📌 Bây giờ chạy deploy.sh từ máy local để đẩy code lên."
