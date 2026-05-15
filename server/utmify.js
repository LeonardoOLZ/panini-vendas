/**
 * Integração com UTMify
 * Doc: https://api.utmify.com.br/api-credentials/orders
 *
 * Envia um evento a cada mudança relevante de status:
 *   - Doação gerada  → status: "waiting_payment"
 *   - Doação paga    → status: "paid"
 *   - Doação recusada → status: "refused" (bônus para melhor reporting)
 */

const UTMIFY_URL = 'https://api.utmify.com.br/api-credentials/orders';
const TOKEN = process.env.UTMIFY_API_TOKEN;

const ENABLED = !!TOKEN;
if (!ENABLED) {
  console.log('ℹ️  UTMify desativada (UTMIFY_API_TOKEN não configurado)');
}

/**
 * Formata data pra ISO 8601 — formato aceito pela UTMify
 */
function toIso(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Mapeia status interno → status da UTMify
 */
function mapStatus(internalStatus) {
  switch (internalStatus) {
    case 'PENDING':   return 'waiting_payment';
    case 'COMPLETED': return 'paid';
    case 'DECLINED':  return 'refused';
    default:          return 'waiting_payment';
  }
}

/**
 * Mapeia método WayMB → método aceito pela UTMify
 * UTMify aceita: credit_card, pix, boleto, free_price (billet/billet_bancario alguns)
 * Como o WayMB é MB WAY / Multibanco, o mais próximo é pix (que representa
 * pagamentos instantâneos / referência). Deixo fixo em 'pix' para Portugal.
 */
function mapPaymentMethod(method) {
  // Em Portugal MB WAY e Multibanco são pagamentos imediatos similares a Pix/boleto
  // UTMify não tem método específico para estes; 'pix' é o mais próximo em natureza
  return 'pix';
}

/**
 * Envia o evento para a UTMify.
 * @param {object} tx - registro do banco
 * @param {'waiting_payment'|'paid'|'refused'} status
 */
async function sendOrder(tx, status) {
  if (!ENABLED) return { skipped: true };

  const utm = tx.utm || {};
  const trackingParameters = {
    src:           utm.src  || null,
    sck:           utm.sck  || null,
    utm_source:    utm.utm_source   || null,
    utm_campaign:  utm.utm_campaign || null,
    utm_medium:    utm.utm_medium   || null,
    utm_content:   utm.utm_content  || null,
    utm_term:      utm.utm_term     || null,
  };

  const priceInCents = Math.round(Number(tx.amount || 0) * 100);

  const body = {
    orderId: tx.id,
    platform: 'CheckoutWayMB',
    paymentMethod: mapPaymentMethod(tx.method),
    status,
    createdAt: toIso(tx.createdAt),
    approvedDate: status === 'paid' ? toIso(tx.approvedAt || Date.now()) : null,
    refundedAt: null,
    customer: {
      name:     tx.payer?.name     || 'Doador Anónimo',
      email:    tx.payer?.email    || 'anonimo@checkout-doacoes.local',
      phone:    tx.payer?.phone    || null,
      document: tx.payer?.document || null,
      country:  'PT',
      ip:       null,
    },
    products: [
      {
        id: 'doacao',
        name: 'Doação',
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents,
      },
    ],
    trackingParameters,
    commission: {
      totalPriceInCents: priceInCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: priceInCents,
    },
    isTest: false,
  };

  try {
    const res = await fetch(UTMIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': TOKEN,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`⚠️  UTMify ${status} falhou [${res.status}]:`, text);
      return { ok: false, status: res.status, body: text };
    }
    console.log(`✅ UTMify ${status} enviado: ${tx.id}`);
    return { ok: true };
  } catch (err) {
    console.error(`⚠️  UTMify ${status} erro de rede:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  enabled: ENABLED,
  sendOrder,
  mapStatus,
};
