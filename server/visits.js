/**
 * Storage de visitas + eventos da landing.
 * Mesmo padrão do db.js: JSON em disco, escrita atómica.
 *
 * Esquema de cada linha:
 *   {
 *     id,                  // uuid-ish
 *     ts,                  // timestamp ms
 *     visitorId,           // gerado no front (localStorage)
 *     event,               // 'visit' | 'checkout_started' | 'checkout_step_1' | 'checkout_step_2' | ...
 *     page,                // 'landing' | 'checkout' | ...
 *     referrer,
 *     userAgent,
 *     ip,
 *     utm: { utm_source, utm_medium, utm_campaign, utm_content, utm_term, src, sck, fbclid, gclid },
 *     meta: {...}          // payload livre por evento
 *   }
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DB_FILE   = path.join(DATA_DIR, 'visits.json');
const TMP_FILE  = path.join(DATA_DIR, 'visits.json.tmp');
const MAX_ROWS  = 50_000; // truncamento defensivo

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let rows = [];
let writing = false;
let pendingWrite = false;

function loadFromDisk() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) rows = arr;
      console.log(`📊 Visitas carregadas: ${rows.length}`);
    }
  } catch (err) {
    console.error('⚠️  Erro a ler visitas, começo vazio:', err.message);
    rows = [];
  }
}
loadFromDisk();

async function persist() {
  if (writing) { pendingWrite = true; return; }
  writing = true;
  try {
    if (rows.length > MAX_ROWS) rows = rows.slice(-MAX_ROWS);
    const json = JSON.stringify(rows, null, 2);
    await fs.promises.writeFile(TMP_FILE, json, 'utf8');
    await fs.promises.rename(TMP_FILE, DB_FILE);
  } catch (err) {
    console.error('❌ Erro a persistir visitas:', err.message);
  } finally {
    writing = false;
    if (pendingWrite) { pendingWrite = false; persist(); }
  }
}

function genId() {
  return 'e_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clean(s) {
  if (s == null) return null;
  s = String(s);
  return s.length > 800 ? s.slice(0, 800) : s;
}

function record({ event, page, visitorId, referrer, userAgent, ip, utm, meta }) {
  const row = {
    id: genId(),
    ts: Date.now(),
    visitorId: clean(visitorId) || null,
    event: clean(event) || 'visit',
    page: clean(page) || null,
    referrer: clean(referrer),
    userAgent: clean(userAgent),
    ip: clean(ip),
    utm: utm && typeof utm === 'object' ? utm : null,
    meta: meta && typeof meta === 'object' ? meta : null,
  };
  rows.push(row);
  persist();
  return row;
}

// ==========================================================
// Agregações para a dashboard
// ==========================================================

function inRange(r, fromMs, toMs) {
  return r.ts >= fromMs && r.ts <= toMs;
}

/**
 * Resumo geral entre [from, to] (timestamps ms).
 */
function dashboardSummary({ from, to } = {}) {
  to   = to   || Date.now();
  from = from || (to - 30 * 24 * 60 * 60 * 1000); // 30d default

  const filtered = rows.filter(r => inRange(r, from, to));

  const visits   = filtered.filter(r => r.event === 'visit');
  const starts   = filtered.filter(r => r.event === 'checkout_started');
  const step1    = filtered.filter(r => r.event === 'checkout_step_1');
  const step2    = filtered.filter(r => r.event === 'checkout_step_2');

  // ----- Eventos do funil /roleta -----
  const roletaVisits  = visits.filter(r => r.page === 'roleta');
  const quizStarted   = filtered.filter(r => r.event === 'quiz_started');
  const quizCompleted = filtered.filter(r => r.event === 'quiz_completed');
  const emailCaptured = filtered.filter(r => r.event === 'email_captured');
  const wheelSpun     = filtered.filter(r => r.event === 'wheel_spin');
  const roletaWon     = filtered.filter(r => r.event === 'roleta_won');
  const storeOpened   = filtered.filter(r => r.event === 'store_opened');
  const addedToCart   = filtered.filter(r => r.event === 'add_to_cart');
  const cartCheckout  = filtered.filter(r => r.event === 'cart_checkout_click');
  const orderCreated  = filtered.filter(r => r.event === 'order_created');
  const orderPaid     = filtered.filter(r => r.event === 'order_paid');

  const uniqueVisitors = new Set(visits.map(r => r.visitorId).filter(Boolean)).size;
  const uniqueRoletaVisitors = new Set(roletaVisits.map(r => r.visitorId).filter(Boolean)).size;

  // série temporal por dia
  const series = {};
  for (const r of filtered) {
    const day = new Date(r.ts);
    day.setHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);
    if (!series[key]) series[key] = { date: key, visits: 0, checkouts: 0, roleta: 0, roletaWon: 0, paid: 0 };
    if (r.event === 'visit') {
      series[key].visits++;
      if (r.page === 'roleta') series[key].roleta++;
    }
    if (r.event === 'checkout_started') series[key].checkouts++;
    if (r.event === 'roleta_won') series[key].roletaWon++;
    if (r.event === 'order_paid') series[key].paid++;
  }
  const seriesArr = Object.values(series).sort((a, b) => a.date.localeCompare(b.date));

  // breakdown por UTM
  function bucket(field) {
    const acc = {};
    for (const r of visits) {
      const v = (r.utm && r.utm[field]) || '(direct)';
      acc[v] = (acc[v] || 0) + 1;
    }
    return Object.entries(acc)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }

  // referrer breakdown
  const refAcc = {};
  for (const r of visits) {
    let ref = '(direct)';
    if (r.referrer) {
      try { ref = new URL(r.referrer).hostname || ref; } catch (e) { ref = r.referrer.slice(0, 60); }
    }
    refAcc[ref] = (refAcc[ref] || 0) + 1;
  }
  const referrers = Object.entries(refAcc)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    range: { from, to },
    totals: {
      visits: visits.length,
      uniqueVisitors,
      checkoutStarted: starts.length,
      step1Completed: step1.length,
      step2Completed: step2.length,
      // ----- Roleta -----
      roletaVisits: roletaVisits.length,
      roletaUniqueVisitors: uniqueRoletaVisitors,
      quizStarted: quizStarted.length,
      quizCompleted: quizCompleted.length,
      emailCaptured: emailCaptured.length,
      wheelSpun: wheelSpun.length,
      roletaWon: roletaWon.length,
      storeOpened: storeOpened.length,
      addedToCart: addedToCart.length,
      cartCheckout: cartCheckout.length,
      orderCreated: orderCreated.length,
      orderPaid: orderPaid.length,
    },
    funnel: [
      { stage: 'Visitou landing', count: visits.length },
      { stage: 'Iniciou checkout', count: starts.length },
      { stage: 'Concluiu dados (1)', count: step1.length },
      { stage: 'Concluiu entrega (2)', count: step2.length },
    ],
    funnelRoleta: [
      { stage: 'Entrou em /roleta', count: roletaVisits.length },
      { stage: 'Comecou o quiz', count: quizStarted.length },
      { stage: 'Terminou as 5 perguntas', count: quizCompleted.length },
      { stage: 'Deixou o email', count: emailCaptured.length },
      { stage: 'Girou a roleta', count: wheelSpun.length },
      { stage: 'Ganhou 90% off', count: roletaWon.length },
      { stage: 'Entrou na loja', count: storeOpened.length },
      { stage: 'Adicionou ao carrinho', count: addedToCart.length },
      { stage: 'Clicou checkout', count: cartCheckout.length },
      { stage: 'Pedido criado', count: orderCreated.length },
      { stage: 'Pagamento confirmado', count: orderPaid.length },
    ],
    series: seriesArr,
    utm: {
      source:   bucket('utm_source'),
      medium:   bucket('utm_medium'),
      campaign: bucket('utm_campaign'),
      content:  bucket('utm_content'),
    },
    referrers,
  };
}

// ==========================================================
// Utilizadores ativos (última janela de tempo)
// ==========================================================
function activeUsers({ windowMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  const since = now - windowMs;
  const recent = rows.filter(r => r.ts >= since);
  const visitors = {};
  for (const r of recent) {
    if (!r.visitorId) continue;
    const v = visitors[r.visitorId] = visitors[r.visitorId] || {
      visitorId: r.visitorId,
      page: null,
      lastEvent: null,
      lastTs: 0,
      firstTs: r.ts,
      utm: null,
      events: 0,
      ip: null,
      userAgent: null,
    };
    v.events++;
    if (r.ts < v.firstTs) v.firstTs = r.ts;
    if (r.ts > v.lastTs) {
      v.lastTs = r.ts;
      v.lastEvent = r.event;
      v.page = r.page || v.page;
      v.utm = r.utm || v.utm;
      v.ip = r.ip || v.ip;
      v.userAgent = r.userAgent || v.userAgent;
    }
  }
  const all = Object.values(visitors).sort((a, b) => b.lastTs - a.lastTs);
  const roleta  = all.filter(v => v.page === 'roleta');
  const landing = all.filter(v => v.page !== 'roleta');
  return {
    windowMs,
    generatedAt: now,
    total: all.length,
    byPage: {
      roleta: roleta.length,
      landing: landing.length,
    },
    visitors: {
      roleta: roleta.slice(0, 50),
      landing: landing.slice(0, 50),
    },
  };
}


function recent(limit = 100) {
  return rows.slice(-limit).reverse();
}

module.exports = { record, dashboardSummary, recent, activeUsers };
