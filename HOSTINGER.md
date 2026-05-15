# Deploy no Hostinger VPS — via GitHub (recomendado)

Este projeto vem com **dois scripts** prontos para deploy no VPS Hostinger:
- `deploy-vps.sh` — primeira instalação (Node 20, nginx, PM2, certbot, SSL)
- `update-vps.sh` — atualizações posteriores (`git pull` + reload)

---

## Parte 1 — No teu PC (uma vez)

### 1.1 Cria um repositório GitHub privado

1. Vai a https://github.com/new
2. Nome: `panini-vendas` · Visibilidade: **Private** · sem README
3. Clica **Create repository**
4. Copia o URL (ex: `https://github.com/oteu-user/panini-vendas.git`)

### 1.2 Subir o código

Abre **PowerShell** (ou Terminal/CMD) na pasta do projeto:

```powershell
cd C:\Users\olive\Downloads\panin\panini-vendas

# Inicializar git
git init
git branch -M main

# Verifica que .gitignore existe e bloqueia .env (já vem incluído no projeto)
type .gitignore

# Adicionar tudo MENOS .env (já está no .gitignore)
git add .
git status         # confirma que .env NÃO aparece — se aparecer, NÃO faças commit
git commit -m "primeiro deploy"

# Ligar ao GitHub e enviar
git remote add origin https://github.com/oteu-user/panini-vendas.git
git push -u origin main
```

> ⚠️ Se o `.env` aparecer em `git status`, **PARA**. Verifica o `.gitignore` e usa `git rm --cached .env` antes de commitar.

---

## Parte 2 — No VPS Hostinger (uma vez)

### 2.1 Apontar o DNS do domínio para o IP do VPS

No Hostinger hPanel → **Domínios** → o teu domínio → **DNS / Nameservers**:

| Tipo | Nome | Valor (IP do VPS) | TTL |
|------|------|---|---|
| A    | @    | <IP-do-VPS> | 300 |
| A    | www  | <IP-do-VPS> | 300 |

Espera 5–15 min para propagar.

### 2.2 SSH no VPS

```bash
ssh root@<IP-do-VPS>
```

### 2.3 Correr o script de deploy (1 linha)

Substitui `<TEU_USER>/<TEU_REPO>` pelo teu repositório (precisas tornar o repo **público temporariamente** OU usar SSH key — ver opção B abaixo):

```bash
# Opção A — repositório público
curl -fsSL https://raw.githubusercontent.com/<TEU_USER>/panini-vendas/main/deploy-vps.sh | \
  REPO_URL=https://github.com/<TEU_USER>/panini-vendas.git bash -s -- oteu-dominio.pt
```

```bash
# Opção B — repositório privado (recomendado): cria deploy key SSH
# 1) No VPS:
ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# 2) Cola essa chave no GitHub: repo → Settings → Deploy keys → Add deploy key
# 3) Depois corre:
git clone git@github.com:<TEU_USER>/panini-vendas.git /var/www/panini-vendas
cd /var/www/panini-vendas
sudo bash deploy-vps.sh oteu-dominio.pt
```

O script vai:
- Instalar Node 20, nginx, PM2, certbot
- `npm install --omit=dev`
- Criar `.env` a partir do `.env.example` com `PUBLIC_URL=https://oteu-dominio.pt` e `NODE_ENV=production`
- Configurar nginx reverse-proxy (porta 80 → 3000)
- Pedir certificado HTTPS (Let's Encrypt)
- Arrancar a app com PM2 (auto-restart no boot)
- Abrir firewall (Nginx + SSH)

### 2.4 Editar o `.env` com as credenciais reais

```bash
nano /var/www/panini-vendas/.env
```

Mete:
```
WAYMB_CLIENT_ID=criadol77_c4a419f9
WAYMB_CLIENT_SECRET=db27f9a1-a9e9-4ebb-8143-825570b24902
WAYMB_ACCOUNT_EMAIL=oteu@email.com
PUBLIC_URL=https://oteu-dominio.pt
NODE_ENV=production
ADMIN_TOKEN=<gera 32 chars aleatórios>
META_PIXEL_ID=1485033180084660
META_CAPI_TOKEN=EAAeyHyxP47MBRcUFAna...
```

Reinicia:
```bash
pm2 restart panini
pm2 logs panini --lines 20    # confirma que arrancou sem erros
```

### 2.5 Configurar webhook no painel WayMB

No teu painel WayMB define:
```
https://oteu-dominio.pt/api/webhook/waymb
```

### 2.6 Testar

- `https://oteu-dominio.pt` → landing
- `https://oteu-dominio.pt/health` → `{"status":"ok"}`
- `https://oteu-dominio.pt/dashboard.html?token=<o-teu-ADMIN_TOKEN>` → dashboard

---

## Parte 3 — Atualizar (sempre que mudares código)

**No teu PC:**
```powershell
cd C:\Users\olive\Downloads\panin\panini-vendas
git add .
git commit -m "o que mudaste"
git push
```

**No VPS:**
```bash
cd /var/www/panini-vendas
bash update-vps.sh
```

Pronto — o `update-vps.sh` faz `git pull` + `npm install` + `pm2 reload panini` (sem downtime).

---

## Comandos úteis no VPS

```bash
pm2 status                    # ver se a app está viva
pm2 logs panini --lines 50    # ver os últimos logs
pm2 restart panini            # reiniciar
pm2 monit                     # monitor live (CPU/RAM)

systemctl status nginx        # estado do nginx
nginx -t && systemctl reload nginx

certbot renew --dry-run       # testar renovação SSL
certbot certificates          # ver certificados ativos

tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Ver dados gravados:
cat /var/www/panini-vendas/data/transactions.json | jq .
cat /var/www/panini-vendas/data/visits.json | jq .
```

---

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `git push` pede password mas é privado | Usa Personal Access Token: GitHub → Settings → Developer settings → PAT |
| `502 Bad Gateway` no nginx | App caiu. `pm2 restart panini` e `pm2 logs panini` |
| Certbot falha | DNS ainda não propagou. Espera 15min e: `certbot --nginx -d oteu-dominio.pt -d www.oteu-dominio.pt` |
| `.env` foi commitado por engano | URGENTE: `git rm --cached .env && git commit && git push`, **regenera todas as credenciais** e considera fazer rebase para apagar do histórico |
| Webhook do WayMB não chega | Confirma que o domínio resolve para o VPS e que o port 443 está aberto: `curl https://oteu-dominio.pt/health` |
| Pixel não dispara no browser | AdBlock. O CAPI server-side continua a registar — confirma no Events Manager > Test events |

---

## Checklist final ✅

- [ ] Domínio aponta para o IP do VPS (DNS A record)
- [ ] `deploy-vps.sh` correu sem erros
- [ ] `.env` editado com credenciais reais e `pm2 restart panini` feito
- [ ] HTTPS ativo (cadeado verde no browser)
- [ ] Webhook WayMB configurado para `/api/webhook/waymb`
- [ ] Foto do produto em `public/images/produto.png` (commitar e `update-vps.sh`)
- [ ] Dashboard acessível em `/dashboard.html?token=...`
- [ ] Pixel a aparecer no Events Manager
- [ ] **Credenciais expostas no chat foram REGENERADAS** (WayMB secret + CAPI token)
- [ ] Backup configurado para `/var/www/panini-vendas/data/` (cron rsync ou similar)
