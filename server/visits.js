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

  const uniqueVisitors = new Set(visits.map(r => r.visitorId).filter(Boolean)).size;

  // série temporal por dia
  const series = {};
  for (const r of filtered) {
    const day = new Date(r.ts);
    day.setHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);
    if (!series[key]) series[key] = { date: key, visits: 0, checkouts: 0 };
    if (r.event === 'visit') series[key].visits++;
    if (r.event === 'checkout_started') series[key].checkouts++;
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
    },
    funnel: [
      { stage: 'Visitou landing', count: visits.length },
      { stage: 'Iniciou checkout', count: starts.length },
      { stage: 'Concluiu dados (1)', count: step1.length },
      { stage: 'Concluiu entrega (2)', count: step2.length },
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

function recent(limit = 100) {
  return rows.slice(-limit).reverse();
}

module.exports = { record, dashboardSummary, recent };
