# Panini Vendas — Landing + Checkout + Dashboard + Pixel

Sistema completo:
- **Landing** estilo Panini Brasil (`/`) com avaliações, ficha técnica, newsletter, footer
- **Checkout** 3 passos (Sacola → Entrega → Pagamento) com **upsells** + MB WAY/Multibanco via gateway WayMB
- **Tracking de UTMs** ponta-a-ponta + integração **UTMify**
- **Meta Pixel + Conversions API** (server-side com dedup por `event_id`)
- **Dashboard** (`/dashboard.html`) com Chart.js: KPIs, série temporal, funnel, breakdown por UTM, pedidos

> 🚀 **Para deploy no Hostinger Node.js, vê [HOSTINGER.md](HOSTINGER.md).**

---

## Estrutura

```
panini-vendas/
├── public/
│   ├── index.html             ← Landing
│   ├── checkout.html          ← Checkout 3 passos
│   ├── checkout.js
│   ├── dashboard.html
│   ├── styles.css
│   ├── success.html / failed.html
│   └── images/
│       ├── produto.png        ← (DROP A FOTO REAL AQUI)
│       └── produto-placeholder.svg
├── server/
│   ├── index.js               ← Express + endpoints
│   ├── db.js                  ← Storage transações
│   ├── visits.js              ← Storage visitas/eventos
│   ├── utmify.js              ← Integração UTMify
│   └── meta-capi.js           ← Meta Conversions API
├── data/                      ← (auto) transactions.json + visits.json
├── package.json · .env · .env.example
├── HOSTINGER.md               ← guia deploy
└── README.md
```

---

## Correr localmente

```bash
npm install
npm run dev          # arranca com --watch
```

Abre `http://localhost:3000`.

### Webhook em dev
O WayMB precisa de URL público. Usa **ngrok**:
```bash
ngrok http 3000
# cola o https://xxxxx.ngrok.io em PUBLIC_URL no .env e reinicia
```

---

## URLs

| URL | Descrição |
|-----|-----------|
| `/` | Landing |
| `/checkout.html` | Checkout |
| `/dashboard.html?token=<ADMIN_TOKEN>` | Dashboard |
| `/health` | Healthcheck |
| `/api/config` | Config pública (preço, pixel id) |

---

## Variáveis `.env`

| Var | Para quê |
|-----|----------|
| `WAYMB_CLIENT_ID` / `WAYMB_CLIENT_SECRET` / `WAYMB_ACCOUNT_EMAIL` | Credenciais gateway (Portugal) |
| `PUBLIC_URL` | URL pública (para webhook + success/failed) |
| `ADMIN_TOKEN` | Entrar na dashboard |
| `PRODUCT_NAME` / `PRODUCT_PRICE` | Produto vendido |
| `META_PIXEL_ID` / `META_CAPI_TOKEN` | Pixel Meta + CAPI server-side |
| `META_CAPI_TEST_EVENT_CODE` | (opcional) testa no Events Manager > Test Events |
| `UTMIFY_API_TOKEN` | (opcional) sync com UTMify |

---

## Fluxo completo (UTMs + Pixel)

1. **Landing** captura `?utm_source=...&fbclid=...` da URL → `sessionStorage` + `POST /api/track/visit`
2. Pixel dispara `PageView` + `ViewContent`
3. **COMPRAR AGORA** dispara Pixel `InitiateCheckout` + propaga UTMs para `/checkout.html`
4. Cada passo dispara evento (`checkout_step_1/2`); ao chegar a Pagamento dispara Pixel `AddPaymentInfo`
5. Submit → `POST /api/checkout` (com `eventId`+`fbp`+`fbc`) → cria transação WayMB
6. Backend dispara **CAPI `InitiateCheckout`** server-side (mesmo `event_id` do browser → dedup)
7. Webhook WayMB confirma → backend grava + dispara **CAPI `Purchase`** server-side
8. Browser polling vê `COMPLETED` → dispara Pixel `Purchase` (mesmo event_id → dedup)
9. UTMify recebe `paid`, dashboard mostra agregado

---

## Endpoints

### Públicos
- `GET  /api/config`
- `POST /api/checkout`
- `GET  /api/status/:id`
- `POST /api/webhook/waymb`
- `POST /api/track/visit` · `POST /api/track/event`

### Admin (`x-admin-token` ou `?token=`)
- `GET /api/admin/dashboard`
- `GET /api/admin/transactions`
- `GET /api/admin/visits-recent`
- `GET /api/admin/stats`
- `GET /api/admin/transaction/:id`

---

## ⚠️ Segurança

Foram partilhadas no chat as seguintes credenciais — **regenera-as antes de produção**:

- WayMB Client Secret (`db27f9a1-...`)
- Meta Conversions API Token (`EAAeyHyxP47MBRcUFAna...`)

E define um `ADMIN_TOKEN` forte (32+ chars aleatórios).
