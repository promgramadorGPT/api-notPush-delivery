const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const admin = require('firebase-admin');
require('dotenv').config();
const { percentualValido, calcularComissao, validarReembolso } = require('./comissao');
const EN = require('./entregadores');

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(v => v.trim()).filter(Boolean);
app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origem não permitida.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-meli-session-id']
}));
app.use(express.json({ limit: '256kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ==========================================
// FIREBASE ADMIN
// ==========================================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  return require('./firebase-key.json');
}

const serviceAccount = loadServiceAccount();
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://yapoodbr-delivery-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

// ==========================================
// HELPERS
// ==========================================
const ok = (res, data) => res.status(200).json(data);
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function getBearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function requireFirebaseUser(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return fail(res, 401, 'Autenticação necessária.');
    req.user = await auth.verifyIdToken(token);
    return next();
  } catch (err) {
    console.error('Auth Firebase:', err.message);
    return fail(res, 401, 'Sessão inválida ou expirada.');
  }
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase();
}

function paymentStatusToApp(status) {
  const s = normalizeStatus(status);
  if (s === 'approved') return 'Aprobado';
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(s)) return 'Rechazado';
  return 'Pendiente de pago';
}

function validPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function makeIdempotencyKey() {
  return crypto.randomUUID().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

// ==========================================
// OAUTH MERCADO PAGO — o lojista conecta a conta (sem digitar chaves)
// client_id/client_secret são da APLICAÇÃO da plataforma (ficam só aqui no servidor).
// ==========================================
const MP_CLIENT_ID = (process.env.MP_CLIENT_ID || '').trim();
const MP_CLIENT_SECRET = (process.env.MP_CLIENT_SECRET || '').trim();
const MP_OAUTH_REDIRECT_URI = (process.env.MP_OAUTH_REDIRECT_URI || 'https://api-mp-yapoodbr.onrender.com/oauth/mp/callback').trim();
const FRONTEND_URL = (process.env.FRONTEND_URL || allowedOrigins[0] || '').replace(/\/$/, '');
const MP_AUTH_URL = 'https://auth.mercadopago.com.br/authorization';
const MP_TOKEN_URL = 'https://api.mercadopago.com/oauth/token';
const OAUTH_STATE_TTL = 10 * 60 * 1000;            // o lojista tem 10 min para autorizar
const REFRESH_MARGIN = 7 * 24 * 60 * 60 * 1000;    // renova 7 dias antes de expirar
const refreshing = new Map();                      // evita renovar a mesma loja em paralelo

function lojaIdValido(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 120 && !/[.#$\[\]\/]/.test(id);
}

async function assertStoreOwner(uid, lojaId) {
  if (!lojaIdValido(lojaId)) return false;
  const snap = await db.ref(`restaurantes/${lojaId}/ownerUid`).once('value');
  return snap.val() === uid;
}

async function mpOAuthRequest(params) {
  const resp = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET, ...params })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    const e = new Error(data.message || data.error_description || data.error || `HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return data;
}

async function saveOAuthTokens(lojaId, data) {
  const now = Date.now();
  await db.ref(`restaurantes_privado/${lojaId}`).update({
    mp_token: data.access_token,
    mp_refresh_token: data.refresh_token || null,
    mp_expires_at: data.expires_in ? now + Number(data.expires_in) * 1000 : null,
    mp_user_id: data.user_id ? String(data.user_id) : null,
    mp_oauth: true,
    mp_atualizado_em: now
  });
  if (data.public_key) {
    // A Public Key é pública por natureza (o navegador do cliente precisa dela para abrir o formulário do cartão).
    await db.ref(`restaurantes/${lojaId}`).update({ mp_public_key: data.public_key, mp_conectado: true, mp_conectado_em: now });
  }
}

async function getSellerToken(lojaId) {
  const snap = await db.ref(`restaurantes_privado/${lojaId}`).once('value');
  const priv = snap.val() || {};
  const token = typeof priv.mp_token === 'string' && priv.mp_token.trim() ? priv.mp_token.trim() : null;
  if (!token) return null;

  // Token digitado manualmente (legado) ou OAuth sem dados de renovação: usa como está.
  if (!priv.mp_oauth || !priv.mp_refresh_token || !MP_CLIENT_ID || !MP_CLIENT_SECRET) return token;

  const expiresAt = Number(priv.mp_expires_at || 0);
  if (!expiresAt || expiresAt - Date.now() > REFRESH_MARGIN) return token;

  if (!refreshing.has(lojaId)) {
    const p = (async () => {
      try {
        const data = await mpOAuthRequest({ grant_type: 'refresh_token', refresh_token: priv.mp_refresh_token });
        await saveOAuthTokens(lojaId, data);
        console.log(`🔄 Token Mercado Pago renovado | loja ${lojaId}`);
        return data.access_token;
      } catch (err) {
        console.error(`Falha ao renovar token | loja ${lojaId}:`, err.message);
        return null;
      } finally {
        refreshing.delete(lojaId);
      }
    })();
    refreshing.set(lojaId, p);
  }
  const novo = await refreshing.get(lojaId);
  if (novo) return novo;
  return expiresAt > Date.now() ? token : null; // renovação falhou: usa o atual enquanto ainda for válido
}

async function getOrderForUser(pedidoKey, userUid, lojaId) {
  const snap = await db.ref(`pedidos/${pedidoKey}`).once('value');
  if (!snap.exists()) return null;
  const pedido = snap.val();
  if (pedido.clienteUid !== userUid) return null;
  if (pedido.lojaId !== lojaId) return null;
  return pedido;
}

// ---- Comissão da plataforma (V2.5) ----
// % única, definida pelo Master em config_plataforma/comissao/percentual.
async function getPercentualPlataforma() {
  try {
    const snap = await db.ref('config_plataforma/comissao/percentual').once('value');
    return percentualValido(snap.val()) ?? 0;
  } catch (err) {
    console.warn('Comissão: não foi possível ler a % da plataforma:', err.message);
    return 0;
  }
}

// Online: split automático (application_fee) quando a loja conectou o Mercado Pago por OAuth.
// Loja com token manual (legado) não aceita split: a comissão fica registrada como "a_acertar".
async function planoComissao(pedido, lojaId) {
  const percentual = await getPercentualPlataforma();
  const c = calcularComissao(pedido, percentual);
  if (!(c.valor > 0)) return { ...c, modo: 'nenhum' };
  const oauth = (await db.ref(`restaurantes_privado/${lojaId}/mp_oauth`).once('value')).val() === true;
  return { ...c, modo: oauth ? 'split' : 'a_acertar' };
}

async function registrarComissao(pedidoKey, plano) {
  try {
    await db.ref(`pedidos/${pedidoKey}/comissaoPlataforma`).set({
      percentual: plano.percentual, base: plano.base, valor: plano.valor, modo: plano.modo, registradaEm: new Date().toISOString()
    });
  } catch (err) { console.warn('Comissão não registrada no pedido:', err.message); }
}

async function getStore(lojaId) {
  const snap = await db.ref(`restaurantes/${lojaId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function createOrReusePaymentAttempt(pedidoKey, lojaId) {
  const ref = db.ref(`pagamentos_por_pedido/${pedidoKey}`);
  const now = Date.now();
  let chosen = null;
  await ref.transaction(current => {
    if (current && current.paymentIdMP) {
      const existingStatus = normalizeStatus(current.status);
      if (!['rejected', 'cancelled', 'refunded', 'charged_back'].includes(existingStatus)) {
        chosen = current;
        return current;
      }
    }
    if (current && current.status === 'creating' && Number(current.createdAt) > now - 10 * 60 * 1000 && current.idempotencyKey) {
      chosen = current;
      return current;
    }
    const next = {
      lojaId,
      pedidoKey,
      idempotencyKey: makeIdempotencyKey(),
      status: 'creating',
      createdAt: now,
      updatedAt: now
    };
    chosen = next;
    return next;
  });
  return chosen;
}

async function savePaymentRecord(pedidoKey, payment) {
  const record = {
    lojaId: payment.lojaId,
    pedidoKey,
    paymentIdMP: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail || null,
    transactionAmount: Number(payment.transaction_amount),
    updatedAt: Date.now()
  };
  await db.ref(`pagamentos_por_pedido/${pedidoKey}`).update(record);
  await db.ref(`pagamentos/${payment.id}`).set(record);
}

async function updateOrderPayment(pedidoKey, payment) {
  const appStatus = paymentStatusToApp(payment.status);
  await db.ref(`pedidos/${pedidoKey}`).update({
    pagoStatus: appStatus,
    paymentIdMP: payment.id,
    paymentStatusMP: payment.status,
    paymentStatusDetailMP: payment.status_detail || null,
    pagoAtualizadoEm: new Date().toISOString()
  });
}

function parseSignature(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  const signature = parseSignature(req.headers['x-signature']);
  const requestId = req.headers['x-request-id'];
  const dataId = req.query['data.id'] || req.query.data_id || '';
  if (!signature.v1 || !signature.ts || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${signature.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ==========================================
// HEALTH
// ==========================================

function pedidoAguardandoPagamento(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'pendiente' || s === 'pendente';
}

app.get('/health', (req, res) => ok(res, { ok: true, service: 'api-mp-yapoodbr' }));

// ==========================================
// PAGAMENTO POR LOJA — PRODUÇÃO
// ==========================================
app.post('/criar-pagamento-loja', requireFirebaseUser, async (req, res) => {
  try {
    const {
      token,
      installments,
      paymentMethodId,
      payer,
      email,
      pedidoKey,
      pedidoId,
      lojaId
    } = req.body || {};

    if (!lojaId || typeof lojaId !== 'string') return fail(res, 400, 'lojaId inválido.');
    if (!pedidoKey || typeof pedidoKey !== 'string') return fail(res, 400, 'pedidoKey é obrigatório.');
    if (!token || typeof token !== 'string') return fail(res, 400, 'Token do cartão inválido.');
    if (!paymentMethodId || typeof paymentMethodId !== 'string') return fail(res, 400, 'Meio de pagamento inválido.');

    const parcelas = Number(installments || 1);
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 24) return fail(res, 400, 'Número de parcelas inválido.');

    const pedido = await getOrderForUser(pedidoKey, req.user.uid, lojaId);
    if (!pedido) return fail(res, 404, 'Pedido não encontrado.');

    if (!pedidoAguardandoPagamento(pedido.status)) return fail(res, 409, 'Este pedido não está disponível para pagamento.');
    const pedidoPagoStatus = normalizeStatus(pedido.paymentStatusMP || pedido.pagoStatus);
    if (pedido.paymentIdMP && !['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pedidoPagoStatus)) {
      return ok(res, { paymentId: pedido.paymentIdMP, status: pedido.paymentStatusMP || 'approved', statusDetail: 'already_processed' });
    }

    const total = Number(pedido.total);
    if (!validPositiveNumber(total)) return fail(res, 400, 'Total do pedido inválido.');

    const loja = await getStore(lojaId);
    if (!loja) return fail(res, 404, 'Loja não encontrada.');
    if (loja.activo === false || loja.activa === false) return fail(res, 409, 'Esta loja não está disponível.');

    const lojaToken = await getSellerToken(lojaId);
    if (!lojaToken) return fail(res, 409, 'Esta loja ainda não conectou uma conta do Mercado Pago.');

    const attempt = await createOrReusePaymentAttempt(pedidoKey, lojaId);
    if (attempt.paymentIdMP) {
      return ok(res, {
        paymentId: attempt.paymentIdMP,
        status: attempt.status,
        statusDetail: attempt.statusDetail || 'already_created'
      });
    }

    const clientLoja = new MercadoPagoConfig({ accessToken: lojaToken });
    const paymentLoja = new Payment(clientLoja);

    const payerData = {
      email: email || payer?.email || pedido?.cliente?.email || 'cliente@email.com'
    };
    if (payer?.identification?.number) {
      payerData.identification = {
        type: payer.identification.type || 'CPF',
        number: String(payer.identification.number)
      };
    } else if (pedido?.cliente?.documento) {
      payerData.identification = {
        type: pedido.cliente.documentoTipo || 'CPF',
        number: String(pedido.cliente.documento)
      };
    }

    const deviceSessionId = String(req.headers['x-meli-session-id'] || '').trim().slice(0, 200);
    const plano = await planoComissao(pedido, lojaId);

    const body = {
      transaction_amount: total,
      token,
      description: `Pedido #${pedido.numeroPedido || pedidoId || pedidoKey}`.slice(0, 150),
      installments: parcelas,
      payment_method_id: paymentMethodId,
      payer: payerData
    };

    if (process.env.MP_WEBHOOK_URL) body.notification_url = process.env.MP_WEBHOOK_URL;
    if (plano.modo === 'split') body.application_fee = plano.valor;

    const requestOptions = { idempotencyKey: attempt.idempotencyKey };
    if (deviceSessionId) requestOptions.headers = { 'X-meli-session-id': deviceSessionId };

    const result = await paymentLoja.create({
      body,
      requestOptions
    });

    await savePaymentRecord(pedidoKey, {
      lojaId,
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      transaction_amount: result.transaction_amount
    });
    await updateOrderPayment(pedidoKey, result);
    if (plano.modo !== 'nenhum') await registrarComissao(pedidoKey, plano);

    console.log(`💳 Loja ${lojaId} | pedido ${pedidoKey} | MP ${result.id} | ${result.status}`);

    return ok(res, {
      paymentId: result.id,
      status: result.status,
      statusDetail: result.status_detail
    });
  } catch (err) {
    console.error('Erro pagamento por loja:', err.cause || err);
    const cause = err.cause?.[0];
    return fail(res, 502, cause?.description || err.message || 'Erro interno no processamento do pagamento.', {
      statusDetail: cause?.code || undefined
    });
  }
});

// ==========================================
// STATUS DE PAGAMENTO — SEM TOKEN DO CLIENTE
// ==========================================
app.get('/status-loja/:lojaId/:paymentId', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, paymentId } = req.params;
    const snap = await db.ref(`pagamentos/${paymentId}`).once('value');
    const map = snap.val();
    if (!map || map.lojaId !== lojaId) return fail(res, 404, 'Pagamento não encontrado.');

    const pedido = await getOrderForUser(map.pedidoKey, req.user.uid, lojaId);
    if (!pedido) return fail(res, 403, 'Não autorizado.');

    const token = await getSellerToken(lojaId);
    if (!token) return fail(res, 409, 'Token da loja indisponível.');

    const paymentClient = new Payment(new MercadoPagoConfig({ accessToken: token }));
    const result = await paymentClient.get({ id: paymentId });
    await updateOrderPayment(map.pedidoKey, result);

    return ok(res, { paymentId: result.id, status: result.status, statusDetail: result.status_detail });
  } catch (err) {
    console.error('Erro status loja:', err.cause || err);
    return fail(res, 502, err.cause?.[0]?.description || err.message || 'Erro ao consultar pagamento.');
  }
});

// ==========================================
// WEBHOOK MERCADO PAGO
// ==========================================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) return res.sendStatus(401);

    const type = req.body?.type || req.query.type;
    if (type !== 'payment') return res.sendStatus(200);

    const paymentId = String(req.body?.data?.id || req.query['data.id'] || '');
    if (!paymentId) return res.sendStatus(200);

    const mapSnap = await db.ref(`pagamentos/${paymentId}`).once('value');
    const map = mapSnap.val();
    if (!map?.lojaId || !map?.pedidoKey) return res.sendStatus(200);

    const token = await getSellerToken(map.lojaId);
    if (!token) return res.sendStatus(200);

    const paymentClient = new Payment(new MercadoPagoConfig({ accessToken: token }));
    const result = await paymentClient.get({ id: paymentId });

    // Não confiar no body do webhook para status/valor: consulta o pagamento autenticado na conta da loja.
    await savePaymentRecord(map.pedidoKey, {
      lojaId: map.lojaId,
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      transaction_amount: result.transaction_amount
    });
    await updateOrderPayment(map.pedidoKey, result);

    console.log(`🔔 Webhook MP ${paymentId} | pedido ${map.pedidoKey} | ${result.status}`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook Mercado Pago:', err.cause || err);
    return res.sendStatus(500);
  }
});

// ==========================================
// PIX POR LOJA — PRODUÇÃO
// Usa o Access Token da própria loja, igual ao cartão.
// ==========================================
app.post('/criar-pix-loja', requireFirebaseUser, async (req, res) => {
  try {
    const { pedidoKey, pedidoId, lojaId, payer, email } = req.body || {};

    if (!lojaId || typeof lojaId !== 'string') return fail(res, 400, 'lojaId inválido.');
    if (!pedidoKey || typeof pedidoKey !== 'string') return fail(res, 400, 'pedidoKey é obrigatório.');

    const pedido = await getOrderForUser(pedidoKey, req.user.uid, lojaId);
    if (!pedido) return fail(res, 404, 'Pedido não encontrado.');

    if (!pedidoAguardandoPagamento(pedido.status)) return fail(res, 409, 'Este pedido não está disponível para pagamento.');
    const pedidoPagoStatus = normalizeStatus(pedido.paymentStatusMP || pedido.pagoStatus);
    if (pedido.paymentIdMP && !['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pedidoPagoStatus)) {
      const saved = await db.ref(`pagamentos/${pedido.paymentIdMP}`).once('value');
      const previous = saved.val();
      return ok(res, {
        paymentId: pedido.paymentIdMP,
        status: pedido.paymentStatusMP || 'approved',
        statusDetail: 'already_processed',
        qrCode: previous?.qrCode || null,
        qrCodeBase64: previous?.qrCodeBase64 || null
      });
    }

    const total = Number(pedido.total);
    if (!validPositiveNumber(total)) return fail(res, 400, 'Total do pedido inválido.');

    const loja = await getStore(lojaId);
    if (!loja) return fail(res, 404, 'Loja não encontrada.');
    if (loja.activo === false || loja.activa === false) return fail(res, 409, 'Esta loja não está disponível.');

    const lojaToken = await getSellerToken(lojaId);
    if (!lojaToken) return fail(res, 409, 'Esta loja ainda não conectou uma conta do Mercado Pago.');

    const attempt = await createOrReusePaymentAttempt(pedidoKey, lojaId);
    if (attempt.paymentIdMP) {
      const saved = await db.ref(`pagamentos/${attempt.paymentIdMP}`).once('value');
      const previous = saved.val();
      return ok(res, {
        paymentId: attempt.paymentIdMP,
        status: attempt.status,
        statusDetail: attempt.statusDetail || 'already_created',
        qrCode: previous?.qrCode || null,
        qrCodeBase64: previous?.qrCodeBase64 || null
      });
    }

    const paymentLoja = new Payment(new MercadoPagoConfig({ accessToken: lojaToken }));
    const payerEmail = email || payer?.email || pedido?.cliente?.email;
    if (!payerEmail) return fail(res, 400, 'E-mail do cliente é obrigatório para o PIX.');

    const payerData = { email: String(payerEmail).trim() };
    if (payer?.identification?.number) {
      payerData.identification = {
        type: payer.identification.type || 'CPF',
        number: String(payer.identification.number)
      };
    } else if (pedido?.cliente?.documento) {
      payerData.identification = {
        type: pedido.cliente.documentoTipo || 'CPF',
        number: String(pedido.cliente.documento)
      };
    }

    const body = {
      transaction_amount: total,
      description: `Pedido #${pedido.numeroPedido || pedidoId || pedidoKey}`.slice(0, 150),
      payment_method_id: 'pix',
      payer: payerData
    };

    if (process.env.MP_WEBHOOK_URL) body.notification_url = process.env.MP_WEBHOOK_URL;
    const plano = await planoComissao(pedido, lojaId);
    if (plano.modo === 'split') body.application_fee = plano.valor;

    const result = await paymentLoja.create({
      body,
      requestOptions: { idempotencyKey: attempt.idempotencyKey }
    });

    const pix = result.point_of_interaction?.transaction_data || {};
    await savePaymentRecord(pedidoKey, {
      lojaId,
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      transaction_amount: result.transaction_amount,
      qrCode: pix.qr_code || null,
      qrCodeBase64: pix.qr_code_base64 || null
    });
    await updateOrderPayment(pedidoKey, result);
    if (plano.modo !== 'nenhum') await registrarComissao(pedidoKey, plano);

    console.log(`🟩 PIX loja ${lojaId} | pedido ${pedidoKey} | MP ${result.id} | ${result.status}`);

    return ok(res, {
      paymentId: result.id,
      status: result.status,
      statusDetail: result.status_detail,
      qrCode: pix.qr_code || null,
      qrCodeBase64: pix.qr_code_base64 || null,
      ticketUrl: pix.ticket_url || null
    });
  } catch (err) {
    console.error('Erro PIX por loja:', err.cause || err);
    const cause = err.cause?.[0];
    return fail(res, 502, cause?.description || err.message || 'Erro interno no processamento do PIX.', {
      statusDetail: cause?.code || undefined
    });
  }
});

// ==========================================
// OAUTH — ROTAS (ADM da loja)
// ==========================================
app.post('/oauth/mp/iniciar', requireFirebaseUser, async (req, res) => {
  try {
    if (!MP_CLIENT_ID || !MP_CLIENT_SECRET) return fail(res, 503, 'A conexão com o Mercado Pago ainda não foi configurada no servidor.');
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Você não é o dono desta loja.');

    const state = crypto.randomBytes(24).toString('hex'); // 48 hex; uso único; amarrado à loja e ao usuário
    await db.ref(`oauth_state/${state}`).set({ lojaId, uid: req.user.uid, createdAt: Date.now() });

    const url = new URL(MP_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: MP_CLIENT_ID,
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: MP_OAUTH_REDIRECT_URI
    }).toString();
    return ok(res, { url: url.toString() });
  } catch (err) {
    console.error('OAuth iniciar:', err.message);
    return fail(res, 500, 'Não foi possível iniciar a conexão com o Mercado Pago.');
  }
});

app.get('/oauth/mp/callback', async (req, res) => {
  const voltar = (status, motivo) => {
    if (!FRONTEND_URL) return res.status(status === 'ok' ? 200 : 400).send(status === 'ok' ? 'Mercado Pago conectado. Pode fechar esta página.' : `Não foi possível conectar (${motivo}).`);
    const q = `mp=${status}${motivo ? `&motivo=${encodeURIComponent(motivo)}` : ''}`;
    return res.redirect(302, `${FRONTEND_URL}/admin-loja.html?${q}`);
  };
  try {
    const { code, state, error } = req.query;
    if (error) return voltar('erro', 'negado');
    if (typeof code !== 'string' || typeof state !== 'string' || !/^[a-f0-9]{48}$/.test(state)) return voltar('erro', 'parametros');

    const stRef = db.ref(`oauth_state/${state}`);
    const snap = await stRef.once('value');
    await stRef.remove(); // uso único, mesmo se algo falhar depois
    const st = snap.val();
    if (!st || Date.now() - Number(st.createdAt) > OAUTH_STATE_TTL) return voltar('erro', 'expirado');
    if (!(await assertStoreOwner(st.uid, st.lojaId))) return voltar('erro', 'dono');

    const data = await mpOAuthRequest({ grant_type: 'authorization_code', code, redirect_uri: MP_OAUTH_REDIRECT_URI });
    await saveOAuthTokens(st.lojaId, data);
    console.log(`🔗 Mercado Pago conectado | loja ${st.lojaId} | MP user ${data.user_id || '?'}`);
    return voltar('ok');
  } catch (err) {
    console.error('OAuth callback:', err.message); // nunca loga code/token/secret
    return voltar('erro', 'falha');
  }
});

app.post('/oauth/mp/status', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Você não é o dono desta loja.');
    const priv = (await db.ref(`restaurantes_privado/${lojaId}`).once('value')).val() || {};
    const pub = (await db.ref(`restaurantes/${lojaId}/mp_public_key`).once('value')).val();
    return ok(res, {
      conectado: !!(typeof priv.mp_token === 'string' && priv.mp_token.trim()),
      via: priv.mp_oauth ? 'oauth' : 'manual',
      mpUserId: priv.mp_user_id || null,
      expiraEm: priv.mp_expires_at || null,
      temPublicKey: !!pub,
      oauthDisponivel: !!(MP_CLIENT_ID && MP_CLIENT_SECRET)
    }); // nunca devolve o token
  } catch (err) {
    console.error('OAuth status:', err.message);
    return fail(res, 500, 'Não foi possível consultar a conexão.');
  }
});

app.post('/oauth/mp/desconectar', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Você não é o dono desta loja.');
    await db.ref(`restaurantes_privado/${lojaId}`).update({
      mp_token: null, mp_refresh_token: null, mp_expires_at: null, mp_user_id: null, mp_oauth: null, mp_atualizado_em: Date.now()
    });
    await db.ref(`restaurantes/${lojaId}`).update({ mp_public_key: null, mp_conectado: null, mp_conectado_em: null });
    console.log(`⛓️‍💥 Mercado Pago desconectado | loja ${lojaId}`);
    return ok(res, { ok: true });
  } catch (err) {
    console.error('OAuth desconectar:', err.message);
    return fail(res, 500, 'Não foi possível desconectar.');
  }
});

// ==========================================
// LEGADO: PIX/CARTÃO CENTRAL
// Mantidos somente para compatibilidade. Não usar no checkout por loja.
// ==========================================
const centralToken = process.env.MP_TOKEN;
const centralPayment = centralToken ? new Payment(new MercadoPagoConfig({ accessToken: centralToken })) : null;

app.post('/criar-pix', async (req, res) => {
  try {
    if (!centralPayment) return fail(res, 503, 'Pagamento central desativado.');
    const { valor, pedidoId } = req.body || {};
    if (!validPositiveNumber(valor)) return fail(res, 400, 'Valor inválido.');
    const result = await centralPayment.create({
      body: { transaction_amount: Number(valor), description: `Pedido #${pedidoId || 'encomenda'}`, payment_method_id: 'pix', payer: { email: 'teste@email.com' } },
      requestOptions: { idempotencyKey: makeIdempotencyKey() }
    });
    const pix = result.point_of_interaction?.transaction_data;
    return ok(res, { paymentId: result.id, qrCode: pix?.qr_code, qrCodeBase64: pix?.qr_code_base64 });
  } catch (err) {
    console.error('Erro PIX central:', err.cause || err);
    return fail(res, 502, err.cause?.[0]?.description || err.message || 'Erro PIX.');
  }
});

app.get('/status/:id', async (req, res) => {
  try {
    if (!centralPayment) return fail(res, 503, 'Pagamento central desativado.');
    const result = await centralPayment.get({ id: req.params.id });
    return ok(res, { status: result.status });
  } catch (err) {
    return fail(res, 502, err.message || 'Erro ao consultar status.');
  }
});

// ==========================================
// ERROS / START
// ==========================================
// ==========================================
// ENTREGADOR / CÓDIGO DE ENTREGA (V2.3)
// Dados só do servidor: entregadores, entregas, entregas_por_entregador, taxas_entregador, entregadores_convites.
// O código (PIN) não é gravado: é derivado de PIN_SECRET + pedidoKey (HMAC).
// ==========================================
const PIN_SECRET = (process.env.PIN_SECRET || '').trim();
const MAX_TENTATIVAS_PIN = 5;
const chaveEmail = e => String(e || '').trim().toLowerCase().replace(/\./g, ',');
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')) && String(e).length <= 160;
function codigoEntrega(pedidoKey) {
  const h = crypto.createHmac('sha256', PIN_SECRET).update(String(pedidoKey)).digest('hex');
  return String(parseInt(h.slice(0, 8), 16) % 10000).padStart(4, '0');
}
const pinConfigurado = (res) => PIN_SECRET.length >= 16 ? true : (fail(res, 503, 'Código de entrega não configurado no servidor.'), false);
const refEntregador = uid => db.ref(`entregadores/${uid}`);
async function getEntregadorAtivo(uid) {
  const s = await refEntregador(uid).once('value');
  const e = s.val();
  return e && e.ativo !== false ? e : null;
}

app.post('/entregador/convidar', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, email, nome } = req.body || {};
    const taxa = Number(req.body?.taxa || 0);
    if (!emailValido(email)) return fail(res, 400, 'E-mail inválido.');
    if (!Number.isFinite(taxa) || taxa < 0 || taxa > 1000) return fail(res, 400, 'Taxa inválida.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja pode cadastrar entregadores.');
    const telefone = EN.limparTelefone(req.body?.telefone);
    if (telefone === null) return fail(res, 400, 'Telefone inválido (use DDD + número).');
    const emailNorm = String(email).trim().toLowerCase();
    if ((await entregadoresDaLoja(lojaId)).some(e => String(e.email || '').toLowerCase() === emailNorm)) return fail(res, 409, 'Este e-mail já é de um entregador da sua loja.');
    const convAnterior = (await db.ref(`entregadores_convites/${chaveEmail(email)}`).once('value')).val();
    if (convAnterior && convAnterior.lojaId !== lojaId) return fail(res, 409, 'Este e-mail já foi convidado por outra loja.');
    await db.ref(`entregadores_convites/${chaveEmail(email)}`).set({
      lojaId, email: emailNorm, nome: EN.limparTexto(nome, 80), telefone, taxaPadrao: taxa, criadoEm: Date.now()
    });
    return ok(res, { ok: true });
  } catch (err) { console.error('Convidar entregador:', err.message); return fail(res, 500, 'Erro ao cadastrar entregador.'); }
});

app.post('/entregador/entrar', requireFirebaseUser, async (req, res) => {
  try {
    const atual = await getEntregadorAtivo(req.user.uid);
    if (atual) return ok(res, { ok: true, nome: atual.nome, lojaId: atual.lojaId });
    if (!req.user.email || req.user.email_verified !== true) return fail(res, 403, 'E-mail da conta Google não verificado.');
    const cs = await db.ref(`entregadores_convites/${chaveEmail(req.user.email)}`).once('value');
    const c = cs.val();
    if (!c) return fail(res, 403, 'Este e-mail não foi cadastrado por nenhuma loja.');
    const e = { lojaId: c.lojaId, nome: c.nome || req.user.name || 'Entregador', email: c.email, taxaPadrao: c.taxaPadrao || 0, telefone: c.telefone || '', ativo: true, criadoEm: Date.now() };
    await refEntregador(req.user.uid).set(e);
    await cs.ref.remove();
    return ok(res, { ok: true, nome: e.nome, lojaId: e.lojaId });
  } catch (err) { console.error('Entrar entregador:', err.message); return fail(res, 500, 'Erro ao entrar.'); }
});

app.post('/entregador/atribuir', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, pedidoKey, entregadorUid } = req.body || {};
    if (typeof pedidoKey !== 'string' || !lojaIdValido(pedidoKey) || typeof entregadorUid !== 'string' || !lojaIdValido(entregadorUid)) return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja pode atribuir entregas.');
    const ent = await getEntregadorAtivo(entregadorUid);
    if (!ent || ent.lojaId !== lojaId) return fail(res, 404, 'Entregador não encontrado nesta loja.');
    const ps = await db.ref(`pedidos/${pedidoKey}`).once('value');
    const p = ps.val();
    if (!p || p.lojaId !== lojaId || p.tipoEntrega !== 'delivery') return fail(res, 404, 'Pedido de entrega não encontrado.');
    const es = await db.ref(`entregas/${pedidoKey}`).once('value');
    if (es.val()?.entregaConfirmada) return fail(res, 409, 'Entrega já confirmada.');
    const taxa = Number.isFinite(Number(req.body?.taxa)) && req.body?.taxa !== undefined ? Number(req.body.taxa) : Number(ent.taxaPadrao || 0);
    if (taxa < 0 || taxa > 1000) return fail(res, 400, 'Taxa inválida.');
    if (es.val()?.entregadorUid && es.val().entregadorUid !== entregadorUid) await db.ref(`entregas_por_entregador/${es.val().entregadorUid}/${pedidoKey}`).remove();
    await db.ref(`entregas/${pedidoKey}`).update({ lojaId, pedidoKey, entregadorUid, taxaEntregador: taxa, atribuidaEm: Date.now(), entregaConfirmada: false });
    await db.ref(`entregas_por_entregador/${entregadorUid}/${pedidoKey}`).set(true);
    return ok(res, { ok: true });
  } catch (err) { console.error('Atribuir entrega:', err.message); return fail(res, 500, 'Erro ao atribuir entrega.'); }
});

app.post('/entregador/minhas', requireFirebaseUser, async (req, res) => {
  try {
    const ent = await getEntregadorAtivo(req.user.uid);
    if (!ent) return fail(res, 403, 'Acesso de entregador não autorizado.');
    const idx = (await db.ref(`entregas_por_entregador/${req.user.uid}`).once('value')).val() || {};
    const chaves = Object.keys(idx).slice(-200);
    const lista = (await Promise.all(chaves.map(async k => {
      const [es, ps] = await Promise.all([db.ref(`entregas/${k}`).once('value'), db.ref(`pedidos/${k}`).once('value')]);
      const e = es.val(), p = ps.val();
      if (!e || !p || e.entregadorUid !== req.user.uid || p.lojaId !== ent.lojaId) return null;
      const cancelado = /cancel/i.test(String(p.status || ''));
      return {
        pedidoKey: k, numeroPedido: p.numeroPedido || k, status: p.status, cancelado,
        confirmada: e.entregaConfirmada === true, confirmadaEm: e.confirmadaEm || null, atribuidaEm: e.atribuidaEm || 0,
        cliente: { nome: p.cliente?.nombre || 'Cliente', telefone: p.cliente?.telefono || '', endereco: p.cliente?.direccion || '', observacao: p.cliente?.observacion || '' },
        itens: (p.itens || []).map(i => ({ qtd: Number(i.qtd) || 0, nome: String(i.nombre || '') })),
        pagamento: p.metodoPago || p.pagoForma || p.formaPagamento || '', pagoStatus: p.pagoStatus || '', total: Number(p.total) || 0,
        taxaEntregador: Number(e.taxaEntregador) || 0, bairro: p.bairro || '', tentativasRestantes: EN.tentativasRestantes(e.tentativas, MAX_TENTATIVAS_PIN)
      };
    }))).filter(Boolean).sort((a, b) => b.atribuidaEm - a.atribuidaEm);
    const taxas = (await db.ref(`taxas_entregador/${req.user.uid}`).once('value')).val() || {};
    const [lojaNome, lojaFone, lojaZap] = await Promise.all(['nombre', 'telefono', 'whatsapp'].map(c => db.ref(`restaurantes/${ent.lojaId}/${c}`).once('value').then(s => s.val())));
    const acertos = Object.entries((await db.ref(`acertos_entregador/${req.user.uid}`).once('value')).val() || {})
      .filter(([, a]) => a && a.lojaId === ent.lojaId)
      .map(([id, a]) => ({ id, valorTotal: Number(a.valorTotal) || 0, qtd: Number(a.qtd) || 0, forma: a.forma, obs: a.obs || '', criadoEm: a.criadoEm }))
      .sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 30);
    return ok(res, { ok: true, entregador: { nome: ent.nome }, loja: { nome: String(lojaNome || ''), telefone: String(lojaZap || lojaFone || '').replace(/\D/g, '') }, entregas: lista,
      taxas: Object.values(taxas).map(t => ({ pedidoKey: t.pedidoKey, valor: t.valor, criadoEm: t.criadoEm, statusPagamento: t.statusPagamento, pagoEm: t.pagoEm || null, acertoId: t.acertoId || null })), acertos });
  } catch (err) { console.error('Minhas entregas:', err.message); return fail(res, 500, 'Erro ao carregar entregas.'); }
});

app.post('/entrega/meu-codigo', requireFirebaseUser, async (req, res) => {
  try {
    if (!pinConfigurado(res)) return;
    const { pedidoKey } = req.body || {};
    if (typeof pedidoKey !== 'string' || !lojaIdValido(pedidoKey)) return fail(res, 400, 'Pedido inválido.');
    const p = (await db.ref(`pedidos/${pedidoKey}`).once('value')).val();
    if (!p || p.clienteUid !== req.user.uid || p.tipoEntrega !== 'delivery') return fail(res, 404, 'Pedido não encontrado.');
    if (/cancel/i.test(String(p.status || ''))) return fail(res, 409, 'Pedido cancelado.');
    return ok(res, { ok: true, codigo: codigoEntrega(pedidoKey) });
  } catch (err) { console.error('Meu código:', err.message); return fail(res, 500, 'Erro ao gerar o código.'); }
});

app.post('/entregador/validar-codigo', requireFirebaseUser, async (req, res) => {
  try {
    if (!pinConfigurado(res)) return;
    const { pedidoKey } = req.body || {};
    const codigo = String(req.body?.codigo || '').trim();
    if (typeof pedidoKey !== 'string' || !lojaIdValido(pedidoKey) || !/^\d{4}$/.test(codigo)) return fail(res, 400, 'Informe o código de 4 dígitos.');
    const ent = await getEntregadorAtivo(req.user.uid);
    if (!ent) return fail(res, 403, 'Acesso de entregador não autorizado.');
    const eRef = db.ref(`entregas/${pedidoKey}`);
    const e = (await eRef.once('value')).val();
    if (!e || e.entregadorUid !== req.user.uid) return fail(res, 404, 'Entrega não encontrada.');
    if (e.entregaConfirmada) return fail(res, 409, 'Entrega já confirmada.');
    const p = (await db.ref(`pedidos/${pedidoKey}`).once('value')).val();
    if (!p || p.lojaId !== e.lojaId || /cancel/i.test(String(p.status || ''))) return fail(res, 409, 'Pedido indisponível para entrega.');
    let liberado = false, usadas = 0;
    await eRef.child('tentativas').transaction(n => { n = Number(n) || 0; if (n >= MAX_TENTATIVAS_PIN) return; liberado = true; usadas = n + 1; return n + 1; });
    if (!liberado) return fail(res, 429, 'Limite de tentativas atingido. Peça ajuda à loja.', { restantes: 0 });
    await eRef.update({ ultimaTentativaEm: Date.now() });
    const certo = Buffer.from(codigoEntrega(pedidoKey)), enviado = Buffer.from(codigo);
    if (!crypto.timingSafeEqual(certo, enviado)) return fail(res, 403, 'Código incorreto.', { restantes: EN.tentativasRestantes(usadas, MAX_TENTATIVAS_PIN) });
    const agora = Date.now();
    await eRef.update({ entregaConfirmada: true, confirmadaEm: agora, confirmadaPor: req.user.uid });
    await db.ref(`pedidos/${pedidoKey}`).update({ status: 'Entregado', entregaConfirmada: true, entregaConfirmadaEm: new Date(agora).toISOString(), atualizadoEm: new Date(agora).toISOString() });
    await db.ref(`taxas_entregador/${req.user.uid}/${pedidoKey}`).set({ lojaId: e.lojaId, pedidoKey, entregadorUid: req.user.uid, valor: Number(e.taxaEntregador) || 0, criadoEm: agora, statusPagamento: 'pendente' });
    return ok(res, { ok: true });
  } catch (err) { console.error('Validar código:', err.message); return fail(res, 500, 'Erro ao validar o código.'); }
});

// ---------- V2.4: gestão de entregadores pelo dono da loja ----------
async function entregadoresDaLoja(lojaId) {
  const s = (await db.ref('entregadores').orderByChild('lojaId').equalTo(lojaId).once('value')).val() || {};
  return Object.entries(s).map(([uid, e]) => ({ uid, nome: e.nome, email: e.email, telefone: e.telefone || '', taxaPadrao: Number(e.taxaPadrao) || 0, ativo: e.ativo !== false }));
}
app.post('/entregador/listar', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const conv = (await db.ref('entregadores_convites').orderByChild('lojaId').equalTo(lojaId).once('value')).val() || {};
    return ok(res, { ok: true, entregadores: await entregadoresDaLoja(lojaId), convites: Object.values(conv).map(c => ({ email: c.email, nome: c.nome, telefone: c.telefone || '', taxaPadrao: Number(c.taxaPadrao) || 0 })) });
  } catch (err) { console.error('Listar entregadores:', err.message); return fail(res, 500, 'Erro ao listar entregadores.'); }
});
app.post('/entregador/taxas', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const ents = await entregadoresDaLoja(lojaId);
    const taxas = [];
    for (const e of ents) {
      const t = (await db.ref(`taxas_entregador/${e.uid}`).once('value')).val() || {};
      Object.values(t).filter(x => x.lojaId === lojaId).forEach(x => taxas.push({ entregadorUid: e.uid, entregador: e.nome, pedidoKey: x.pedidoKey, valor: Number(x.valor) || 0, criadoEm: x.criadoEm, statusPagamento: x.statusPagamento, pagoEm: x.pagoEm || null, acertoId: x.acertoId || null }));
    }
    return ok(res, { ok: true, taxas: taxas.sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 500) });
  } catch (err) { console.error('Taxas entregador:', err.message); return fail(res, 500, 'Erro ao listar taxas.'); }
});
app.post('/entregador/pagar-taxa', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, entregadorUid, pedidoKey } = req.body || {};
    if (!lojaIdValido(String(entregadorUid)) || !lojaIdValido(String(pedidoKey))) return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const r = db.ref(`taxas_entregador/${entregadorUid}/${pedidoKey}`);
    const t = (await r.once('value')).val();
    if (!t || t.lojaId !== lojaId) return fail(res, 404, 'Taxa não encontrada.');
    await r.update({ statusPagamento: 'pago', pagoEm: Date.now() });
    return ok(res, { ok: true });
  } catch (err) { console.error('Pagar taxa:', err.message); return fail(res, 500, 'Erro ao registrar pagamento.'); }
});
app.post('/entregador/ativar', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, entregadorUid, ativo } = req.body || {};
    if (!lojaIdValido(String(entregadorUid)) || typeof ativo !== 'boolean') return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const e = (await refEntregador(entregadorUid).once('value')).val();
    if (!e || e.lojaId !== lojaId) return fail(res, 404, 'Entregador não encontrado.');
    await refEntregador(entregadorUid).update({ ativo });
    return ok(res, { ok: true });
  } catch (err) { console.error('Ativar entregador:', err.message); return fail(res, 500, 'Erro ao atualizar entregador.'); }
});


// ---------- V2.6: gestão completa pelo dono da loja ----------
app.post('/entregador/editar', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, entregadorUid } = req.body || {};
    if (!lojaIdValido(String(entregadorUid))) return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const e = (await refEntregador(entregadorUid).once('value')).val();
    if (!e || e.lojaId !== lojaId) return fail(res, 404, 'Entregador não encontrado.');
    const v = EN.validarEdicao(req.body);
    if (v.erro) return fail(res, 400, v.erro);
    await refEntregador(entregadorUid).update(v.campos);
    return ok(res, { ok: true });
  } catch (err) { console.error('Editar entregador:', err.message); return fail(res, 500, 'Erro ao editar entregador.'); }
});

app.post('/entregador/cancelar-convite', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, email } = req.body || {};
    if (!emailValido(email)) return fail(res, 400, 'E-mail inválido.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const r = db.ref(`entregadores_convites/${chaveEmail(email)}`);
    const c = (await r.once('value')).val();
    if (!c || c.lojaId !== lojaId) return fail(res, 404, 'Convite não encontrado.');
    await r.remove();
    return ok(res, { ok: true });
  } catch (err) { console.error('Cancelar convite:', err.message); return fail(res, 500, 'Erro ao cancelar convite.'); }
});

app.post('/entregador/desatribuir', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, pedidoKey } = req.body || {};
    if (typeof pedidoKey !== 'string' || !lojaIdValido(pedidoKey)) return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const r = db.ref(`entregas/${pedidoKey}`);
    const e = (await r.once('value')).val();
    if (!e || e.lojaId !== lojaId) return fail(res, 404, 'Entrega não encontrada.');
    if (e.entregaConfirmada) return fail(res, 409, 'Entrega já confirmada: não dá para desfazer.');
    if (e.entregadorUid) await db.ref(`entregas_por_entregador/${e.entregadorUid}/${pedidoKey}`).remove();
    await r.remove();
    return ok(res, { ok: true });
  } catch (err) { console.error('Desatribuir entrega:', err.message); return fail(res, 500, 'Erro ao desfazer a atribuição.'); }
});

// Entregas da loja (todas as pessoas): alimenta "Entregas" do painel. Antes da V2.6 o painel chamava esta rota, mas ela não existia.
app.post('/entregador/entregas', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const itens = [];
    for (const ent of await entregadoresDaLoja(lojaId)) {
      const idx = (await db.ref(`entregas_por_entregador/${ent.uid}`).once('value')).val() || {};
      for (const k of Object.keys(idx).slice(-60)) {
        const [es, ps] = await Promise.all([db.ref(`entregas/${k}`).once('value'), db.ref(`pedidos/${k}`).once('value')]);
        const x = es.val(), p = ps.val();
        if (!x || !p || x.entregadorUid !== ent.uid || p.lojaId !== lojaId) continue;
        itens.push({
          pedidoKey: k, entregadorUid: ent.uid, entregador: ent.nome, taxa: Number(x.taxaEntregador) || 0, atribuidaEm: x.atribuidaEm || 0,
          confirmada: x.entregaConfirmada === true, confirmadaEm: x.confirmadaEm || null, cancelado: /cancel/i.test(String(p.status || '')),
          numeroPedido: p.numeroPedido || k, status: p.status || '', endereco: p.cliente?.direccion || '', bairro: p.bairro || '',
          clienteNome: p.cliente?.nombre || '', clienteTelefone: p.cliente?.telefono || ''
        });
      }
    }
    return ok(res, { ok: true, entregas: itens.sort((a, b) => b.atribuidaEm - a.atribuidaEm).slice(0, 200) });
  } catch (err) { console.error('Entregas da loja:', err.message); return fail(res, 500, 'Erro ao listar entregas.'); }
});

// Paga várias taxas de um entregador de uma vez e guarda o comprovante (acerto). Cada taxa é "reservada" por transação:
// duas chamadas simultâneas nunca pagam (nem somam) a mesma taxa duas vezes.
app.post('/entregador/pagar-lote', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, entregadorUid } = req.body || {};
    if (!lojaIdValido(String(entregadorUid))) return fail(res, 400, 'Dados inválidos.');
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const v = EN.validarAcerto(req.body);
    if (v.erro) return fail(res, 400, v.erro);
    const ent = (await refEntregador(entregadorUid).once('value')).val();
    if (!ent || ent.lojaId !== lojaId) return fail(res, 404, 'Entregador não encontrado.');
    const taxas = (await db.ref(`taxas_entregador/${entregadorUid}`).once('value')).val() || {};
    const sel = EN.selecionarPendentes(taxas, lojaId, v.pedidoKeys);
    if (!sel.pagaveis.length) return fail(res, 409, 'Nenhuma taxa pendente para pagar.');
    const lote = sel.pagaveis.slice(0, EN.MAX_LOTE), restam = sel.pagaveis.length - lote.length;
    const acertoRef = db.ref(`acertos_entregador/${entregadorUid}`).push();
    const agora = Date.now(), pagas = [];
    for (const x of lote) {
      const r = await db.ref(`taxas_entregador/${entregadorUid}/${x.pedidoKey}/statusPagamento`).transaction(cur => (cur === 'pago' ? undefined : 'pago'));
      if (!r.committed) continue;
      pagas.push(x);
      await db.ref(`taxas_entregador/${entregadorUid}/${x.pedidoKey}`).update({ pagoEm: agora, acertoId: acertoRef.key, formaPagamento: v.forma });
    }
    if (!pagas.length) return fail(res, 409, 'Essas taxas já foram pagas.');
    const acerto = EN.montarAcerto({ lojaId, entregadorUid, entregadorNome: ent.nome, pagas, forma: v.forma, obs: v.obs, agora, criadoPor: req.user.uid });
    await acertoRef.set(acerto);
    return ok(res, { ok: true, acertoId: acertoRef.key, qtd: acerto.qtd, valorTotal: acerto.valorTotal, ignoradas: sel.ignoradas + (lote.length - pagas.length), restam });
  } catch (err) { console.error('Pagar lote:', err.message); return fail(res, 500, 'Erro ao registrar o pagamento.'); }
});

app.post('/entregador/acertos', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId } = req.body || {};
    if (!(await assertStoreOwner(req.user.uid, lojaId))) return fail(res, 403, 'Apenas o dono da loja.');
    const lista = [];
    for (const ent of await entregadoresDaLoja(lojaId)) {
      const a = (await db.ref(`acertos_entregador/${ent.uid}`).once('value')).val() || {};
      Object.entries(a).filter(([, x]) => x && x.lojaId === lojaId).forEach(([id, x]) => lista.push({
        id, entregadorUid: ent.uid, entregador: x.entregador || ent.nome, forma: x.forma, obs: x.obs || '', qtd: Number(x.qtd) || 0, valorTotal: Number(x.valorTotal) || 0, criadoEm: x.criadoEm
      }));
    }
    return ok(res, { ok: true, acertos: lista.sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 100) });
  } catch (err) { console.error('Acertos:', err.message); return fail(res, 500, 'Erro ao listar pagamentos.'); }
});


// ==========================================
// REEMBOLSO — devolve o dinheiro pelo Mercado Pago (V2.5)
// A loja decide no painel (status "aprovado"); esta rota só executa a devolução, com o token da própria loja.
// Com split, o Mercado Pago devolve também a parte da plataforma na mesma proporção (conferir no sandbox).
// ==========================================
app.post('/reembolso/executar', requireFirebaseUser, async (req, res) => {
  const { pedidoKey } = req.body || {};
  if (typeof pedidoKey !== 'string' || !pedidoKey || /[.#$\[\]\/]/.test(pedidoKey)) return fail(res, 400, 'pedidoKey inválido.');
  let execRef = null;
  try {
    const snap = await db.ref(`pedidos/${pedidoKey}`).once('value');
    if (!snap.exists()) return fail(res, 404, 'Pedido não encontrado.');
    const pedido = snap.val();
    if (!(await assertStoreOwner(req.user.uid, pedido.lojaId))) return fail(res, 403, 'Somente o dono da loja pode devolver o valor.');

    const v = validarReembolso(pedido);
    if (!v.ok) return fail(res, v.status, v.erro);

    const token = await getSellerToken(pedido.lojaId);
    if (!token) return fail(res, 409, 'Esta loja não tem uma conta do Mercado Pago conectada.');

    // Trava contra clique duplo / duas abas: só uma devolução por vez, e nunca duas concluídas.
    execRef = db.ref(`pedidos/${pedidoKey}/reembolso/execucao`);
    const tx = await execRef.transaction((cur) => (cur && (cur.status === 'processando' || cur.status === 'concluido'))
      ? undefined : { status: 'processando', em: new Date().toISOString(), por: req.user.uid });
    if (!tx.committed) return fail(res, 409, 'A devolução deste reembolso já foi iniciada.');

    let data = {};
    try {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(v.paymentId)}/refunds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': `reembolso-${pedidoKey}-${v.valor}` },
        body: JSON.stringify({ amount: v.valor })
      });
      data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.message || data.error || 'O Mercado Pago recusou a devolução.'), { mp: data });
    } catch (err) {
      await execRef.set({ status: 'falhou', erro: String(err.message || 'Falha na devolução.').slice(0, 200), em: new Date().toISOString(), por: req.user.uid });
      console.error(`Reembolso falhou | pedido ${pedidoKey}:`, err.mp || err.message);
      return fail(res, 502, err.message || 'Não foi possível devolver o valor agora.');
    }

    await execRef.set({ status: 'concluido', mpRefundId: data.id ?? null, valor: v.valor, em: new Date().toISOString(), por: req.user.uid });
    console.log(`↩️ Reembolso | loja ${pedido.lojaId} | pedido ${pedidoKey} | R$ ${v.valor} | MP ${data.id ?? '-'}`);
    return ok(res, { ok: true, valor: v.valor, refundId: data.id ?? null });
  } catch (err) {
    console.error('Erro no reembolso:', err.message);
    if (execRef) await execRef.set({ status: 'falhou', erro: 'Erro interno.', em: new Date().toISOString() }).catch(() => {});
    return fail(res, 500, 'Erro interno ao devolver o valor.');
  }
});

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  return fail(res, 500, 'Erro interno.');
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`🔥 API Mercado Pago rodando na porta ${PORT}`));
