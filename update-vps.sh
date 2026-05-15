#!/usr/bin/env bash
# Atualiza a app no VPS após push para GitHub.
# Uso (no VPS):  cd /var/www/panini-vendas && bash update-vps.sh
set -euo pipefail
cd "$(dirname "$0")"
git pull
npm install --omit=dev
pm2 reload panini
echo "OK — app atualizada"
