/**
 * Meta Conversions API (CAPI) — server-side events
 * Doc: https://developers.facebook.com/docs/marketing-api/conversions-api
 *
 * Envia eventos diretamente do servidor para a Meta, complementando
 * (ou substituindo, se o browser bloquear) o Pixel client-side.
 *
 * Eventos suportados:
 *   - InitiateCheckout  → quando o pedido é criado
 *   - Purchase          → quando o pagamento é confirmado
 */
const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN    = process.env.META_CAPI_TOKEN;
const TEST_CODE = process.env.META_CAPI_TEST_EVENT_CODE; // opcional, para testar no Events Manager

const ENABLED = !!(PIXEL_ID && TOKEN);
if (!ENABLED) {
  console.log('[i] Meta CAPI desativada (META_PIXEL_ID / META_CAPI_TOKEN nao configurados)');
}

const API_URL = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events`;

function sha256Lower(s) {
  if (!s) return null;
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
}

/**
 * Constrói o user_data a partir do payer + UTMs + IP
 */
function buildUserData({ payer, ip, userAgent, fbp, fbc }) {
  const ud = {};
  if (payer?.email) ud.em = sha256Lower(payer.email);
  if (payer?.phone) {
    // Meta espera phone só com dígitos (sem +)
    ud.ph = sha256Lower(String(payer.phone).replace(/\D/g, ''));
  }
  if (payer?.name) {
    const parts = String(payer.name).trim().split(/\s+/);
    if (parts.length >= 2) {
      ud.fn = sha256Lower(parts[0]);
      ud.ln = sha256Lower(parts[parts.length - 1]);
    } else if (parts[0]) {
      ud.fn = sha256Lower(parts[0]);
    }
  }
  if (ip) ud.client_ip_address = ip;
  if (userAgent) ud.client_user_agent = userAgent;
  if (fbp) ud.fbp = fbp;
  if (fbc) ud.fbc = fbc;
  return ud;
}

/**
 * Envia um evento.
 *
 * @param {object} opts
 *   eventName       - 'InitiateCheckout' | 'Purchase' | etc.
 *   eventId         - mesmo ID usado no Pixel (browser) para deduplicação
 *   eventSourceUrl  - URL onde aconteceu (landing/checkout)
 *   payer           - { name, email, phone }
 *   ip, userAgent   - do request original
 *   fbp, fbc        - cookies do Pixel se disponíveis
 *   value, currency, contents - dados de transação
 */
async function sendEvent({
  eventName, eventId, eventSourceUrl, payer, ip, userAgent, fbp, fbc,
  value, currency = 'EUR', contents,
}) {
  if (!ENABLED) return { skipped: true };

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_id: eventId || crypto.randomUUID(),
    event_source_url: eventSourceUrl || null,
    user_data: buildUserData({ payer, ip, userAgent, fbp, fbc }),
    custom_data: {},
  };

  if (value != null) event.custom_data.value = Number(value);
  if (currency)      event.custom_data.currency = currency;
  if (contents)      event.custom_data.contents = contents;

  const body = { data: [event] };
  if (TEST_CODE) body.test_event_code = TEST_CODE;

  try {
    const res = await fetch(API_URL + '?access_token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[!] CAPI ${eventName} falhou [${res.status}]:`, JSON.stringify(data));
      return { ok: false, status: res.status, body: data };
    }
    console.log(`[OK] CAPI ${eventName} enviado:`, data.events_received || data);
    return { ok: true, body: data };
  } catch (err) {
    console.error(`[!] CAPI ${eventName} erro de rede:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { enabled: ENABLED, sendEvent, pixelId: PIXEL_ID };
