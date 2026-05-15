#!/usr/bin/env bash
# =====================================================================
# Panini Vendas — script de deploy VPS Hostinger (Ubuntu 22/24)
# Uso (no VPS, como root ou sudo):
#   curl -fsSL https://raw.githubusercontent.com/<TEU_USER>/<TEU_REPO>/main/deploy-vps.sh | bash -s -- <DOMINIO>
#   ou clona o repo e corre: sudo bash deploy-vps.sh <DOMINIO>
# Depois cria/edita o .env com as credenciais reais e:
#   pm2 restart panini
# =====================================================================
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/var/www/panini-vendas"
REPO_URL="${REPO_URL:-https://github.com/SEU_USER/SEU_REPO.git}"  # exporta REPO_URL=... antes para customizar
APP_PORT="${APP_PORT:-3000}"

if [[ -z "$DOMAIN" ]]; then
  echo "Uso: sudo bash deploy-vps.sh <DOMINIO>"
  echo "Ex:  sudo bash deploy-vps.sh paninivendas.pt"
  exit 1
fi

echo "==> Atualizar pacotes"
apt update -y && apt upgrade -y

echo "==> Instalar Node.js 20 + ferramentas"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
apt install -y git nginx certbot python3-certbot-nginx ufw build-essential

echo "==> Instalar PM2 globalmente"
npm install -g pm2

echo "==> Clonar / atualizar repo em $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
  git pull
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Instalar dependências (production)"
npm ci --omit=dev || npm install --omit=dev

echo "==> Criar .env se não existir (vais editar depois)"
if [[ ! -f .env ]]; then
  cp .env.example .env
  sed -i "s|PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env
  sed -i "s|NODE_ENV=.*|NODE_ENV=production|" .env
  echo ""
  echo "================================================================"
  echo "  ⚠️  EDITA O .env AGORA com as tuas credenciais REAIS:"
  echo "      nano $APP_DIR/.env"
  echo "  E depois reinicia:    pm2 restart panini"
  echo "================================================================"
  echo ""
fi

echo "==> Garantir pasta data/ com permissões"
mkdir -p "$APP_DIR/data"
chown -R www-data:www-data "$APP_DIR/data" 2>/dev/null || true
chmod 755 "$APP_DIR/data"

echo "==> Configurar PM2"
pm2 delete panini 2>/dev/null || true
pm2 start server/index.js --name panini --cwd "$APP_DIR"
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "==> Configurar nginx reverse-proxy para $DOMAIN"
cat > /etc/nginx/sites-available/panini <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
    }
}
NGX
ln -sf /etc/nginx/sites-available/panini /etc/nginx/sites-enabled/panini
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Firewall"
ufw allow 'Nginx Full' || true
ufw allow OpenSSH || true
yes | ufw enable || true

echo "==> Obter certificado SSL Let's Encrypt"
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
  echo "(certbot falhou, verifica DNS apontado para este IP e corre manualmente: certbot --nginx -d $DOMAIN -d www.$DOMAIN)"

echo ""
echo "==============================================="
echo " ✅  Deploy concluido"
echo "    Site:       https://$DOMAIN"
echo "    Health:     https://$DOMAIN/health"
echo "    Dashboard:  https://$DOMAIN/dashboard.html?token=<ADMIN_TOKEN>"
echo ""
echo " Próximos passos:"
echo "   1. nano /var/www/panini-vendas/.env  (mete credenciais reais)"
echo "   2. pm2 restart panini"
echo "   3. No painel WayMB define o webhook:"
echo "      https://$DOMAIN/api/webhook/waymb"
echo "==============================================="
