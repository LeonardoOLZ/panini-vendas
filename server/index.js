require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const utmify = require('./utmify');
const visits = require('./visits');
const capi = require('./meta-capi');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const WAYMB_BASE = 'https://api.waymb.com';
const {
  WAYMB_CLIENT_ID, WAYMB_CLIENT_SECRET, WAYMB_ACCOUNT_EMAIL,
  PUBLIC_URL, NODE_ENV, ADMIN_TOKEN,
  PRODUCT_NAME, PRODUCT_PRICE, SHIPPING_EXPRESS_PRICE,
  META_PIXEL_ID,
} = process.env;

if (!WAYMB_CLIENT_ID || !WAYMB_CLIENT_SECRET || !WAYMB_ACCOUNT_EMAIL) {
  console.error('Variaveis WAYMB_* nao configuradas. Veja .env.example'); process.exit(1);
}
if (!PUBLIC_URL) { console.error('PUBLIC_URL nao configurado.'); process.exit(1); }

const IS_PROD = NODE_ENV === 'production';

const PRODUCT_CFG = {
  productId:    'kit-basico',
  productName:  PRODUCT_NAME  || 'Kit Básico',
  productPrice: Number(PRODUCT_PRICE || 14.99),
  shippingExpressPrice: Number(SHIPPING_EXPRESS_PRICE || 4.90),
  currency: 'EUR',
};

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (IS_PROD && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const rateBuckets = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = req.path + '|' + ip;
    const now = Date.now();
    const entry = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    rateBuckets.set(key, entry);
    if (entry.count > maxReq) return res.status(429).json({ error: 'Demasiadas tentativas.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of rateBuckets) if (now > entry.reset) rateBuckets.delete(k);
}, 60000);

function sanitizePhone(phone) {
  const c = String(phone || '').replace(/\s+/g, '');
  if (/^\+\d{8,}$/.test(c)) return c;
  if (/^\d{9}$/.test(c)) return '+351' + c;
  return c;
}
function buildPayer({ anonymous, phone, name, email, nif }) {
  const cp = sanitizePhone(phone);
  if (anonymous) return { name:'Cliente Anonimo', email:'anonimo@panini-vendas.local', document:'000000000', phone: cp };
  return { name:(name||'').trim(), email:(email||'').trim().toLowerCase(), document:(nif||'000000000').trim(), phone: cp };
}
function sanitizeUtm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','src','sck','fbclid','gclid','xcod'];
  const out = {}; let any = false;
  for (const k of allowed) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0 && v.length < 500) { out[k] = v; any = true; }
  }
  return any ? out : null;
}

function logInfo(m, e)  { console.log('[i] ' + new Date().toISOString() + ' ' + m, e || ''); }
function logWarn(m, e)  { console.warn('[!] ' + new Date().toISOString() + ' ' + m, e || ''); }
function logError(m, e) { console.error('[X] ' + new Date().toISOString() + ' ' + m, e || ''); }

app.get('/health', (req, res) => res.json({ status:'ok', uptime:process.uptime(), utmify:utmify.enabled, capi:capi.enabled }));

// Config pública usada pelo frontend (preço, pixel id, etc.)
app.get('/api/config', (req, res) => res.json({ ...PRODUCT_CFG, pixelId: META_PIXEL_ID || null }));

// === Tracking interno ===
app.post('/api/track/visit', rateLimit(60, 60000), (req, res) => {
  try {
    const { visitorId, page, referrer, userAgent, utm } = req.body || {};
    visits.record({
      event:'visit', page: page || 'landing',
      visitorId, referrer, userAgent, ip: req.ip,
      utm: sanitizeUtm(utm),
    });
    res.json({ ok: true });
  } catch (err) { logError('Erro track/visit', err.message); res.status(500).json({ ok: false }); }
});
app.post('/api/track/event', rateLimit(60, 60000), (req, res) => {
  try {
    const { visitorId, event, page, utm, meta } = req.body || {};
    if (!event) return res.status(400).json({ error: 'event obrigatorio' });
    visits.record({
      event, page: page || null,
      visitorId, ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
      utm: sanitizeUtm(utm), meta,
    });
    res.json({ ok: true });
  } catch (err) { logError('Erro track/event', err.message); res.status(500).json({ ok: false }); }
});

// === Checkout ===
app.post('/api/checkout', rateLimit(10, 60000), async (req, res) => {
  try {
    const { amount, method, anonymous, phone, name, email, nif, utm, product, shipping,
            eventId, fbp, fbc, sourceUrl } = req.body;

    if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error:'Valor invalido.' });
    if (Number(amount) > 10000) return res.status(400).json({ error:'Valor maximo excedido.' });
    if (!['mbway','multibanco'].includes(method)) return res.status(400).json({ error:'Metodo invalido.' });
    if (!phone) return res.status(400).json({ error:'Telemovel obrigatorio.' });
    if (!anonymous) {
      if (!name)  return res.status(400).json({ error:'Nome obrigatorio.' });
      if (!email) return res.status(400).json({ error:'E-mail obrigatorio.' });
    }

    const payer = buildPayer({ anonymous, phone, name, email, nif });
    const cleanUtm = sanitizeUtm(utm);

    const payload = {
      client_id: WAYMB_CLIENT_ID, client_secret: WAYMB_CLIENT_SECRET, account_email: WAYMB_ACCOUNT_EMAIL,
      amount: Number(amount), method, currency: 'EUR', payer,
      callbackUrl: PUBLIC_URL + '/api/webhook/waymb',
      success_url: PUBLIC_URL + '/success.html',
      failed_url:  PUBLIC_URL + '/failed.html',
    };

    const waymbRes = await fetch(WAYMB_BASE + '/transactions/create', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload),
    });
    const data = await waymbRes.json();

    if (!waymbRes.ok || data.statusCode !== 200) {
      logError('WayMB create falhou', data);
      return res.status(502).json({ error:'Falha ao criar transacao no gateway.', details: IS_PROD ? undefined : data });
    }

    const record = db.createTransaction({
      id: data.id, status: 'PENDING',
      amount: data.amount, method: data.method, currency: 'EUR',
      anonymous: !!anonymous,
      payer_name: payer.name, payer_email: payer.email,
      payer_document: payer.document, payer_phone: payer.phone,
      mb_entity:    data.referenceData && data.referenceData.entity,
      mb_reference: data.referenceData && data.referenceData.reference,
      mb_expires_at:data.referenceData && data.referenceData.expiresAt,
      created_at: data.createdAt || Date.now(), updated_at: Date.now(),
      raw_create: data, utm: cleanUtm,
      product: { ...(product || {}), eventId, fbp, fbc, sourceUrl },
      shipping: shipping || null,
    });

    logInfo('Pedido criado ' + data.id + ' [' + data.method + '] ' + data.amount + ' EUR' + (cleanUtm ? ' (UTM)' : ''));

    visits.record({
      event:'order_created', page:'checkout',
      visitorId: req.body.visitorId || null,
      ip: req.ip, userAgent: req.headers['user-agent'] || null,
      utm: cleanUtm,
      meta: { id:data.id, amount:data.amount, method:data.method },
    });

    // CAPI: InitiateCheckout
    if (capi.enabled) {
      capi.sendEvent({
        eventName: 'InitiateCheckout',
        eventId,
        eventSourceUrl: sourceUrl || (PUBLIC_URL + '/checkout.html'),
        payer,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || null,
        fbp, fbc,
        value: Number(data.amount),
        currency: 'EUR',
        contents: [{ id: PRODUCT_CFG.productId, quantity: 1, item_price: Number(data.amount) }],
      }).catch(err => logError('CAPI InitiateCheckout falhou', err.message));
    }

    if (utmify.enabled) {
      utmify.sendOrder(record, 'waiting_payment')
        .then(r => { if (r && r.ok) db.markUtmifySent(record.id, 'waitingPayment'); })
        .catch(err => logError('UTMify waiting_payment falhou', err.message));
    }

    res.json({
      id: data.id, amount: data.amount, method: data.method,
      referenceData: data.referenceData || null,
      generatedMBWay: data.generatedMBWay || false,
    });
  } catch (err) {
    logError('Erro /api/checkout', err.message);
    res.status(500).json({ error:'Erro interno do servidor.' });
  }
});

app.get('/api/status/:id', async (req, res) => {
  const { id } = req.params;
  const row = db.getById(id);
  if (row && (row.status === 'COMPLETED' || row.status === 'DECLINED')) return res.json({ id, status: row.status });

  try {
    const r = await fetch(WAYMB_BASE + '/transactions/info', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }),
    });
    const data = await r.json();
    const status = data.status || 'PENDING';

    if (row && status !== row.status) {
      db.updateStatus(id, status, data);
      if (status === 'COMPLETED') handlePurchase(id, 'polling');
      if (utmify.enabled) {
        const fresh = db.getById(id);
        if (status === 'COMPLETED' && !(fresh.utmifySent && fresh.utmifySent.paid)) {
          utmify.sendOrder(fresh, 'paid')
            .then(r2 => { if (r2 && r2.ok) db.markUtmifySent(id, 'paid'); })
            .catch(err => logError('UTMify paid falhou', err.message));
        }
      }
    }
    res.json({ id, status });
  } catch (err) {
    logError('Erro /api/status', err.message);
    res.json({ id, status: (row && row.status) || 'PENDING' });
  }
});

app.post('/api/webhook/waymb', (req, res) => {
  const body = req.body || {};
  const id = body.transactionId || body.id;
  const status = body.status;
  if (!id || !status) { logWarn('Webhook invalido', body); return res.status(400).json({ ok:false }); }

  try {
    const existing = db.getById(id);
    if (!existing) {
      logWarn('Webhook para transacao desconhecida: ' + id);
    } else {
      db.updateStatus(id, status, body);
      logInfo('Webhook WayMB: ' + id + ' -> ' + status);

      if (status === 'COMPLETED') handlePurchase(id, 'webhook');
      if (status === 'DECLINED') {
        visits.record({ event:'order_declined', page:'webhook', meta:{ id }, utm: existing.utm || null });
        if (utmify.enabled) {
          utmify.sendOrder(db.getById(id), 'refused').catch(err => logError('UTMify refused falhou', err.message));
        }
      }
    }
  } catch (err) {
    logError('Erro a processar webhook', err.message);
  }
  res.status(200).json({ ok: true });
});

/**
 * Lida com confirmação de pagamento: tracking interno + CAPI Purchase + UTMify.
 * Idempotente por flag utmifySent.paid.
 */
function handlePurchase(id, source) {
  const tx = db.getById(id);
  if (!tx) return;

  visits.record({
    event:'order_paid', page: source,
    meta: { id, amount: tx.amount, method: tx.method },
    utm: tx.utm || null,
  });

  if (capi.enabled) {
    const productMeta = tx.product || {};
    capi.sendEvent({
      eventName: 'Purchase',
      eventId: productMeta.eventId || ('purchase_' + id), // mesmo event_id usado no front faz dedup
      eventSourceUrl: productMeta.sourceUrl || (PUBLIC_URL + '/success.html'),
      payer: tx.payer,
      ip: null, userAgent: null,
      fbp: productMeta.fbp, fbc: productMeta.fbc,
      value: Number(tx.amount),
      currency: 'EUR',
      contents: [{ id: PRODUCT_CFG.productId, quantity: 1, item_price: Number(tx.amount) }],
    }).catch(err => logError('CAPI Purchase falhou', err.message));
  }

  if (utmify.enabled && !(tx.utmifySent && tx.utmifySent.paid)) {
    utmify.sendOrder(tx, 'paid')
      .then(r => { if (r && r.ok) db.markUtmifySent(id, 'paid'); })
      .catch(err => logError('UTMify paid falhou', err.message));
  }
}

// === Admin ===
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).end();
  const given = req.headers['x-admin-token'] || req.query.token;
  if (given !== ADMIN_TOKEN) return res.status(401).json({ error:'unauthorized' });
  next();
}
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.listRecent(limit));
});
app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(db.getStats()));
app.get('/api/admin/transaction/:id', requireAdmin, (req, res) => {
  const t = db.getRaw(req.params.id);
  if (!t) return res.status(404).json({ error:'not found' });
  res.json(t);
});
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : null;
  const to   = req.query.to   ? Number(req.query.to)   : null;
  const summary = visits.dashboardSummary({ from, to });
  const orders = db.listRecent(50);
  const stats = db.getStats();
  const totalRevenue = stats.filter(s => s.status === 'COMPLETED').reduce((sum, s) => sum + Number(s.total || 0), 0);
  res.json({ ...summary, revenue: { total: totalRevenue, currency:'EUR' }, statsByStatus: stats, orders });
});
app.get('/api/admin/visits-recent', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(visits.recent(limit));
});

// ============================================================================
// SETTINGS (logo + hero) â€” upload e injeÃ§Ã£o no HTML
// Inserir antes de app.listen()
// ============================================================================

const multer = require('multer');
const settings = require('./settings');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Storage do multer: salva em public/uploads/ com nome previsÃ­vel
const uploadStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    // Determina tipo (logo ou hero) pela rota
    const kind = req.path.includes('upload-logo') ? 'logo' : 'hero';
    // ExtensÃ£o segura
    const allowed = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    const ext = allowed[file.mimetype] || 'png';
    cb(null, kind + '.' + ext);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    const allowed = ['image/jpeg','image/jpg','image/png','image/webp','image/svg+xml'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Tipo nÃ£o suportado: ' + file.mimetype));
    }
    cb(null, true);
  },
});

// Helper: apaga logos/heros antigos (extensÃµes diferentes) antes de salvar nova
function cleanupOldFiles(kind) {
  const extensions = ['jpg','png','webp','svg'];
  for (const ext of extensions) {
    const oldPath = path.join(UPLOAD_DIR, kind + '.' + ext);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch {}
    }
  }
}

// Endpoint: ler configuraÃ§Ãµes atuais
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(settings.read());
});

// Endpoint: upload de logo
app.post('/api/admin/upload-logo', requireAdmin, (req, res, next) => {
  cleanupOldFiles('logo');
  upload.single('file')(req, res, function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const result = settings.setLogo(req.file.filename);
    res.json({ ok: true, settings: result });
  });
});

// Endpoint: upload de hero
app.post('/api/admin/upload-hero', requireAdmin, (req, res, next) => {
  cleanupOldFiles('hero');
  upload.single('file')(req, res, function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const result = settings.setHero(req.file.filename);
    res.json({ ok: true, settings: result });
  });
});

// ============================================================================
// MIDDLEWARE DE TEMPLATING â€” injeta logo/hero no HTML antes de servir
// Inserir ANTES de app.use(express.static(...))
// ============================================================================

function serveTemplatedHtml(filename) {
  return function (req, res, next) {
    const filePath = path.join(__dirname, '..', 'public', filename);
    fs.readFile(filePath, 'utf8', function (err, html) {
      if (err) return next();
      const logoUrl = settings.getLogoUrl();
      const heroUrl = settings.getHeroUrl();
      // Logo na index (topbar)
      if (logoUrl) {
        // Substitui o div texto por <img>
        html = html.replace(
          /<div class="topbar-logo">[\s\S]*?<\/div>/,
          '<div class="topbar-logo topbar-logo-img"><img src="' + logoUrl + '" alt="Logo"></div>'
        );
        // Substitui o checkout logo
        html = html.replace(
          /<div class="ck-logo"[^>]*>[\s\S]*?<\/div>/,
          '<div class="ck-logo ck-logo-img" aria-label="Logo"><img src="' + logoUrl + '" alt="Logo"></div>'
        );
        // Footer logo (mesma estrutura do topbar)
        html = html.replace(
          /<div class="footer-logo">[\s\S]*?<\/div>/,
          '<div class="footer-logo footer-logo-img"><img src="' + logoUrl + '" alt="Logo"></div>'
        );
      }
      // Hero image
      if (heroUrl) {
        html = html.replace(
          /<div class="hero-img">[\s\S]*?<\/div>/,
          '<div class="hero-img"><img src="' + heroUrl + '" alt="Produto"></div>'
        );
      }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });
  };
}

// Servir HTMLs principais com templating
app.get('/', serveTemplatedHtml('index.html'));
app.get('/index.html', serveTemplatedHtml('index.html'));
app.get('/checkout', serveTemplatedHtml('checkout.html'));
app.get('/checkout.html', serveTemplatedHtml('checkout.html'));

// Funil paralelo: Roleta da Sorte (quiz + roleta -> checkout)
// Sistema independente da landing principal — mesmo backend, página separada.
app.get('/roleta', serveTemplatedHtml('roleta.html'));
app.get('/roleta.html', serveTemplatedHtml('roleta.html'));
app.get('/checkout-roleta', serveTemplatedHtml('checkout-roleta.html'));
app.get('/checkout-roleta.html', serveTemplatedHtml('checkout-roleta.html'));


app.listen(PORT, () => {
  console.log('Panini-vendas a correr na porta ' + PORT + ' (' + (IS_PROD ? 'prod' : 'dev') + ')');
  console.log('  URL publica: ' + PUBLIC_URL);
  console.log('  Webhook:     ' + PUBLIC_URL + '/api/webhook/waymb');
  console.log('  Produto:     ' + PRODUCT_CFG.productName + ' - ' + PRODUCT_CFG.productPrice + ' EUR');
  console.log('  UTMify:      ' + (utmify.enabled ? 'ATIVA' : 'desativada'));
  console.log('  Meta CAPI:   ' + (capi.enabled  ? 'ATIVA (pixel ' + capi.pixelId + ')' : 'desativada'));
  console.log('  Dashboard:   ' + PUBLIC_URL + '/dashboard.html?token=' + (ADMIN_TOKEN || '<defina ADMIN_TOKEN>'));
});

process.on('SIGTERM', () => { logInfo('SIGTERM recebido, encerrando...'); process.exit(0); });
process.on('SIGINT',  () => { logInfo('SIGINT recebido, encerrando...');  process.exit(0); });
