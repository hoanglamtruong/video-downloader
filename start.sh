#!/bin/bash
cd "$(dirname "$0")"
PORT="${PORT:-8097}"
echo "🚀 Khởi động Zdown Video Downloader..."
echo "   Địa chỉ: http://localhost:${PORT}"
echo "   Nhấn Ctrl+C để dừng"
echo ""
node server.js
