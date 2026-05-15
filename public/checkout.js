// =====================================================================
// Panini Checkout — 3 passos + upsells + MB WAY/Multibanco
// =====================================================================

const UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term',
                  'src','sck','fbclid','gclid','xcod'];
const UTM_STORAGE_KEY = 'checkout_utm_params_v1';

function captureUtmsFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const found = {}; let any = false;
    UTM_KEYS.forEach(k => { const v = params.get(k); if (v) { found[k] = v; any = true; } });
    if (any) sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(found));
    return any ? found : null;
  } catch (e) { return null; }
}
function getStoredUtms() {
  try { return JSON.parse(sessionStorage.getItem(UTM_STORAGE_KEY) || 'null'); }
  catch (e) { return null; }
}
function getOrMakeVisitorId() {
  let id = localStorage.getItem('panini_visitor_id');
  if (!id) {
    id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('panini_visitor_id', id);
  }
  return id;
}
captureUtmsFromUrl();

// ===== Helpers Meta Pixel =====
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}
function getCheckoutEventId() {
  let id = sessionStorage.getItem('panini_checkout_eventid');
  if (!id) {
    id = 'ev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('panini_checkout_eventid', id);
  }
  return id;
}
function genPurchaseEventId() {
  return 'pur_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const state = {
  product: { id: 'kit-basico', name: 'Kit Básico', detail: '1 Álbum + 10 saquetas', unitPrice: 14.99 },
  qty: Math.max(1, parseInt(new URLSearchParams(location.search).get('qty') || '1', 10)),
  method: 'mbway',
  data: {},
  upsells: {}, // { id: { id, name, price } }
  txId: null,
  pollTimer: null,
};

function fmt(v) { return new Intl.NumberFormat('pt-PT', { style:'currency', currency:'EUR' }).format(v); }
function totals() {
  const sub = state.product.unitPrice * state.qty;
  const ups = Object.values(state.upsells).reduce((s, u) => s + u.price, 0);
  return { sub, ups, total: sub + ups };
}

function recalcTotals() {
  const t = totals();
  document.getElementById('cartTotal').textContent = fmt(t.sub);
  const sub = document.getElementById('sumSubtotal');
  if (sub) sub.textContent = fmt(t.sub);
  const tot = document.getElementById('sumTotal');
  if (tot) tot.textContent = fmt(t.total);

  // upsells linha por linha
  const wrap = document.getElementById('sumUpsellsWrap');
  if (wrap) {
    wrap.innerHTML = '';
    Object.values(state.upsells).forEach(u => {
      const div = document.createElement('div');
      div.className = 'summary-line';
      div.innerHTML = `<span>+ ${u.name}</span><span>${fmt(u.price)}</span>`;
      wrap.appendChild(div);
    });
  }
  document.getElementById('sumProductLabel').textContent = 'Subtotal ' + state.product.name.toLowerCase();
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    state.product.unitPrice = Number(cfg.productPrice || state.product.unitPrice);
    state.product.name      = cfg.productName || state.product.name;
    document.getElementById('pName').textContent   = state.product.name;
  } catch (e) { /* fallback */ }
  recalcTotals();
}

// ===== Navegação =====
const SCREENS = ['screen-data','screen-shipping','screen-payment','screen-waiting','screen-success','screen-failure'];
function showScreen(id) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('active', s === id);
  });
  const stepMap = { 'screen-data': 1, 'screen-shipping': 2, 'screen-payment': 3 };
  const step = stepMap[id];
  document.querySelectorAll('#stepIndicator .step').forEach(li => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === step);
    li.classList.toggle('done',   step != null && n < step);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// VOLTAR buttons
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});

// ===== Validação =====
function setError(field, msg) {
  const grp = document.querySelector(`[data-field="${field}"]`);
  if (!grp) return;
  if (msg) {
    grp.classList.add('has-error');
    const e = grp.querySelector('.err'); if (e) e.textContent = msg;
  } else {
    grp.classList.remove('has-error');
    const e = grp.querySelector('.err'); if (e) e.textContent = '';
  }
}
function clearErrors(scope) {
  scope.querySelectorAll('.form-group.has-error').forEach(g => g.classList.remove('has-error'));
  scope.querySelectorAll('.form-group .err').forEach(e => e.textContent = '');
}

function validStep1() {
  clearErrors(document.getElementById('screen-data'));
  let ok = true;
  const email = document.getElementById('fEmail').value.trim();
  const name  = document.getElementById('fName').value.trim();
  const phone = document.getElementById('fPhone').value.trim();
  const nif   = document.getElementById('fNif').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { setError('email', 'E-mail inválido.'); ok = false; }
  if (!name || name.length < 3)      { setError('name',  'Obrigatório.'); ok = false; }
  if (!/^\d{9}$/.test(phone))        { setError('phone', 'Inválido (9 dígitos).'); ok = false; }
  if (!/^\d{9}$/.test(nif))          { setError('nif',   'Inválido (9 dígitos).'); ok = false; }
  if (ok) state.data = { email, name, phone, nif };
  return ok;
}
function validStep2() {
  clearErrors(document.getElementById('screen-shipping'));
  let ok = true;
  const cp     = document.getElementById('sCp').value.trim();
  const street = document.getElementById('sStreet').value.trim();
  const num    = document.getElementById('sNum').value.trim();
  const city   = document.getElementById('sCity').value.trim();
  const dist   = document.getElementById('sDistrict').value;
  if (!/^\d{4}-?\d{3}$/.test(cp))  { setError('cp', 'Formato inválido (ex: 1000-001).'); ok = false; }
  if (!street || street.length < 4) { setError('street', 'Obrigatório.'); ok = false; }
  if (!num)                         { setError('num', 'Obrigatório.'); ok = false; }
  if (!city)                        { setError('city', 'Obrigatório.'); ok = false; }
  if (!dist)                        { setError('district', 'Selecciona um distrito.'); ok = false; }
  if (ok) {
    state.data.address = {
      cp, street, num, city, district: dist,
      floor: document.getElementById('sFloor').value.trim() || null,
    };
  }
  return ok;
}

// ===== Eventos navegação =====
document.getElementById('btnGoStep2').addEventListener('click', () => {
  if (validStep1()) {
    fetch('/api/track/event', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ visitorId: getOrMakeVisitorId(), event: 'checkout_step_1', utm: getStoredUtms() }) }).catch(()=>{});
    showScreen('screen-shipping');
  }
});
document.getElementById('btnGoStep3').addEventListener('click', () => {
  if (validStep2()) {
    fetch('/api/track/event', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ visitorId: getOrMakeVisitorId(), event: 'checkout_step_2', utm: getStoredUtms() }) }).catch(()=>{});
    showScreen('screen-payment');
    if (typeof fbq === 'function') {
      fbq('track', 'AddPaymentInfo', {
        content_ids: [state.product.id], content_type: 'product',
        value: totals().total, currency: 'EUR',
      }, { eventID: getCheckoutEventId() });
    }
  }
});

// ===== Upsells =====
document.querySelectorAll('.upsell-item').forEach(item => {
  const btn = item.querySelector('.upsell-btn');
  btn.addEventListener('click', () => {
    const id = item.dataset.id;
    const price = Number(item.dataset.price);
    const name = item.querySelector('.upsell-name').textContent;
    if (state.upsells[id]) {
      delete state.upsells[id];
      item.classList.remove('added');
      btn.textContent = '+ Adicionar ao pedido';
    } else {
      state.upsells[id] = { id, name, price };
      item.classList.add('added');
      btn.textContent = '✓ Adicionado — clica para remover';
    }
    recalcTotals();
  });
});

// ===== Métodos pagamento =====
document.querySelectorAll('.pay-method').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.pay-method').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.method = card.dataset.method;
    document.getElementById('mbwayExtra').style.display = (state.method === 'mbway') ? 'block' : 'none';
  });
});

// ===== Pagar =====
document.getElementById('btnPay').addEventListener('click', processPayment);
document.getElementById('btnRetry').addEventListener('click', () => showScreen('screen-payment'));

async function processPayment() {
  const btn = document.getElementById('btnPay');
  btn.disabled = true; btn.textContent = 'A processar...';
  try {
    // Se MB WAY, valida o telemóvel específico
    let mbwayPhone = null;
    if (state.method === 'mbway') {
      mbwayPhone = document.getElementById('mbwayPhone').value.trim();
      if (!/^\d{9}$/.test(mbwayPhone)) {
        alert('Indica um telemóvel válido para o MB WAY (9 dígitos).');
        btn.disabled = false; btn.textContent = 'Finalizar pedido ›';
        return;
      }
    }
    const t = totals();
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: t.total,
        method: state.method,
        anonymous: false,
        eventId: getCheckoutEventId(),
        fbp: getCookie('_fbp'),
        fbc: getCookie('_fbc'),
        sourceUrl: window.location.href,
        name:  state.data.name,
        email: state.data.email,
        nif:   state.data.nif,
        phone: state.method === 'mbway' ? mbwayPhone : state.data.phone,
        product: {
          id: state.product.id, name: state.product.name,
          qty: state.qty, unitPrice: state.product.unitPrice,
          upsells: Object.values(state.upsells),
        },
        shipping: { mode: 'standard', price: 0, address: state.data.address },
        utm: getStoredUtms(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao criar pagamento.');
    state.txId = data.id;
    showWaiting(data);
    startPolling(data.id);
  } catch (err) {
    showFailure(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Finalizar pedido ›';
  }
}

function showWaiting(data) {
  const title = document.getElementById('waitingTitle');
  const text  = document.getElementById('waitingText');
  const card  = document.getElementById('mbRefCard');
  if (data.method === 'mbway') {
    title.textContent = 'Aguardando confirmação MB WAY';
    text.textContent  = 'Foi enviada uma notificação para o teu telemóvel. Confirma o pagamento no app MB WAY.';
    card.classList.add('hidden');
  } else {
    title.textContent = 'Usa estes dados Multibanco';
    text.textContent  = 'Efetua o pagamento no homebanking ou caixa Multibanco com os dados abaixo.';
    card.classList.remove('hidden');
    const ref = data.referenceData || {};
    document.getElementById('mbEntity').textContent    = ref.entity    || '—';
    document.getElementById('mbReference').textContent = ref.reference || '—';
    document.getElementById('mbAmount').textContent    = fmt(data.amount);
    document.getElementById('mbExpires').textContent   = ref.expiresAt || '—';
  }
  showScreen('screen-waiting');
}

function startPolling(id) {
  stopPolling();
  state.pollTimer = setTimeout(async function poll() {
    try {
      const r = await fetch('/api/status/' + id);
      const d = await r.json();
      if (d.status === 'COMPLETED') {
        stopPolling();
        if (typeof fbq === 'function') {
          fbq('track', 'Purchase', {
            content_ids: [state.product.id], content_type: 'product',
            value: totals().total, currency: 'EUR',
          }, { eventID: 'purchase_' + state.txId });
        }
        showScreen('screen-success'); return;
      }
      if (d.status === 'DECLINED')  { stopPolling(); showFailure('O pagamento foi recusado.'); return; }
      state.pollTimer = setTimeout(poll, 4000);
    } catch (e) { state.pollTimer = setTimeout(poll, 6000); }
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
}
function showFailure(msg) {
  stopPolling();
  if (msg) document.getElementById('failureMsg').textContent = msg;
  showScreen('screen-failure');
}

// Countdown decorativo
let secondsLeft = 9 * 60 + 10;
function tickCountdown() {
  const m = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const s = String(secondsLeft % 60).padStart(2, '0');
  const el = document.getElementById('countdown');
  if (el) el.textContent = m + ':' + s;
  if (secondsLeft > 0) secondsLeft--;
}
tickCountdown(); setInterval(tickCountdown, 1000);

let live = { people: 30, sold: 107 };
function jiggle() {
  live.people = Math.max(8, Math.min(58, live.people + (Math.random() < 0.5 ? -1 : 1)));
  if (Math.random() < 0.18) live.sold += 1;
  const p = document.getElementById('livePeople'); if (p) p.textContent = live.people;
  const s = document.getElementById('liveSold');   if (s) s.textContent = live.sold;
}
setInterval(jiggle, 5000);

loadConfig();
showScreen('screen-data');
