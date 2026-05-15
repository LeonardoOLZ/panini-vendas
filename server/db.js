/**
 * Storage de transações em ficheiro JSON, com escrita atómica.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'transactions.json');
const TMP_FILE = path.join(DATA_DIR, 'transactions.json.tmp');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new Map();
let writing = false;
let pendingWrite = false;

function loadFromDisk() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach(t => { if (t && t.id) store.set(t.id, t); });
      console.log('[i] Banco carregado: ' + store.size + ' transacoes');
    } else {
      console.log('[i] Banco novo criado em ' + DB_FILE);
    }
  } catch (err) {
    console.error('[!] Erro a ler banco, comeco vazio:', err.message);
  }
}
async function persist() {
  if (writing) { pendingWrite = true; return; }
  writing = true;
  try {
    const arr = Array.from(store.values());
    await fs.promises.writeFile(TMP_FILE, JSON.stringify(arr, null, 2), 'utf8');
    await fs.promises.rename(TMP_FILE, DB_FILE);
  } catch (err) {
    console.error('[X] Erro a persistir banco:', err.message);
  } finally {
    writing = false;
    if (pendingWrite) { pendingWrite = false; persist(); }
  }
}
loadFromDisk();

module.exports = {
  createTransaction(data) {
    const record = {
      id: data.id,
      status: data.status || 'PENDING',
      amount: data.amount,
      method: data.method,
      currency: data.currency || 'EUR',
      anonymous: !!data.anonymous,
      payer: {
        name:     data.payer_name || null,
        email:    data.payer_email || null,
        document: data.payer_document || null,
        phone:    data.payer_phone || null,
      },
      referenceData: (data.mb_entity || data.mb_reference) ? {
        entity:    data.mb_entity || null,
        reference: data.mb_reference || null,
        expiresAt: data.mb_expires_at || null,
      } : null,
      product:  data.product  || null,
      shipping: data.shipping || null,
      utm: data.utm || null,
      trackingParameters: data.trackingParameters || null,
      utmifySent: { waitingPayment: false, paid: false },
      createdAt: data.created_at || Date.now(),
      updatedAt: data.updated_at || Date.now(),
      approvedAt: null,
      rawCreate:  data.raw_create || null,
      rawLastHook: null,
    };
    store.set(record.id, record);
    persist();
    return record;
  },

  updateStatus(id, status, rawWebhook = null) {
    const existing = store.get(id);
    if (!existing) return null;
    existing.status = status;
    existing.updatedAt = Date.now();
    if (status === 'COMPLETED' && !existing.approvedAt) existing.approvedAt = Date.now();
    if (rawWebhook) existing.rawLastHook = rawWebhook;
    store.set(id, existing);
    persist();
    return existing;
  },

  markUtmifySent(id, which) {
    const existing = store.get(id);
    if (!existing) return null;
    if (!existing.utmifySent) existing.utmifySent = { waitingPayment: false, paid: false };
    existing.utmifySent[which] = true;
    store.set(id, existing);
    persist();
    return existing;
  },

  getById(id) { return store.get(id) || null; },

  listRecent(limit = 50) {
    return Array.from(store.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(t => ({
        id: t.id, status: t.status, amount: t.amount, method: t.method,
        anonymous: t.anonymous,
        payer_name: t.payer && t.payer.name,
        payer_email: t.payer && t.payer.email,
        utm_source:   t.utm && t.utm.utm_source,
        utm_campaign: t.utm && t.utm.utm_campaign,
        created_at: t.createdAt, updated_at: t.updatedAt,
      }));
  },

  getStats() {
    const stats = {};
    for (const t of store.values()) {
      if (!stats[t.status]) stats[t.status] = { status: t.status, count: 0, total: 0 };
      stats[t.status].count += 1;
      stats[t.status].total += Number(t.amount) || 0;
    }
    return Object.values(stats);
  },

  getRaw(id) { return store.get(id) || null; },
};
