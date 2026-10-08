// V2.5 — comissão da plataforma (application_fee) e rota de reembolso. Roda sem rede: Firebase, Express e Mercado Pago simulados.
const Module = require('module');
const assert = require('assert');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
process.env.PORT = '3998';

// ---- 1) funções puras ----
const C = require('../comissao');
{
  assert.equal(C.percentualValido(10), 10); assert.equal(C.percentualValido('7.5'), 7.5);
  assert.equal(C.percentualValido(-1), null); assert.equal(C.percentualValido(51), null); assert.equal(C.percentualValido('x'), null); assert.equal(C.percentualValido(null), 0);
  // base: produtos ANTES de qualquer desconto, sem entrega (cupom é custo da loja)
  assert.equal(C.baseComissao({ subtotal: 50, desconto: 0, precioEnvio: 6 }), 50);
  assert.equal(C.baseComissao({ subtotal: 50, desconto: 6, precioEnvio: 6 }), 50);   // entrega grátis não reduz a base
  assert.equal(C.baseComissao({ subtotal: 50, desconto: 16, precioEnvio: 6 }), 50);  // cupom nos produtos não reduz a base
  assert.equal(C.baseComissao({ subtotal: 50, desconto: 5, precioEnvio: 5 }), 50);   // pizza 50 + 5 de entrega, cupom 10%
  assert.equal(C.calcularComissao({ subtotal: 50, desconto: 5, precioEnvio: 5, total: 50 }, 10).valor, 5);
  assert.equal(C.baseComissao({ subtotal: 20, desconto: 40, precioEnvio: 0 }), 20);
  assert.equal(C.baseComissao({ itens: [{ precio: 10, qtd: 2 }], desconto: 0, precioEnvio: 5 }), 20);
  assert.deepEqual(C.calcularComissao({ subtotal: 50, desconto: 0, precioEnvio: 6, total: 56 }, 10), { percentual: 10, base: 50, valor: 5 });
  assert.equal(C.calcularComissao({ subtotal: 50, total: 56 }, 0).valor, 0);
  assert.equal(C.calcularComissao({ subtotal: 50, total: 56 }, 99).valor, 0); // % inválida = sem comissão
  assert.equal(C.calcularComissao({ subtotal: 100, desconto: 0, precioEnvio: 0, total: 3 }, 50).valor, 2.99); // taxa < valor cobrado
  console.log('ok 1 funções puras (% e base)');

  const ped = (o = {}) => ({ total: 56, paymentIdMP: 999, paymentStatusMP: 'approved', pagoStatus: 'Aprobado', reembolso: { status: 'aprovado', origem: 'loja', valor: 56 }, ...o });
  assert.equal(C.validarReembolso(ped()).ok, true);
  assert.equal(C.validarReembolso(ped({ reembolso: undefined })).ok, false);
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'solicitado', valor: 5 } })).status, 409);
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'aprovado', valor: 5, execucao: { status: 'concluido' } } })).ok, false);
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'aprovado', valor: 5, execucao: { status: 'processando' } } })).ok, false);
  assert.equal(C.validarReembolso(ped({ paymentIdMP: undefined })).ok, false);
  assert.equal(C.validarReembolso(ped({ paymentStatusMP: 'pending', pagoStatus: 'Pendente de pago' })).ok, false);
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'aprovado', valor: 99, origem: 'loja' } })).status, 400);
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'aprovado', valor: 0, origem: 'loja' } })).status, 400);
  assert.equal(C.validarReembolso(ped({ entregaConfirmada: true, reembolso: { status: 'aprovado', origem: 'cliente', valor: 5 } })).ok, false);
  assert.equal(C.validarReembolso(ped({ entregaConfirmada: true, reembolso: { status: 'aprovado', origem: 'loja', valor: 5 } })).ok, true); // decisão da própria loja
  assert.equal(C.validarReembolso(ped({ reembolso: { status: 'aprovado', origem: 'loja', valor: 20.5 } })).valor, 20.5); // parcial
  console.log('ok 2 validação de reembolso');
}

// ---- 2) rotas com Firebase/Express/MP simulados ----
const tree = {};
const seg = (p) => p.split('/').filter(Boolean);
const getAt = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
const setAt = (p, v) => { const s = seg(p); let o = tree; s.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }); if (v === null || v === undefined) delete o[s[s.length - 1]]; else o[s[s.length - 1]] = JSON.parse(JSON.stringify(v)); };
const fakeDb = { ref: (p) => ({
  once: async () => { const v = getAt(p); const c = v === undefined ? null : JSON.parse(JSON.stringify(v)); return { val: () => c, exists: () => c !== null }; },
  set: async (v) => setAt(p, v),
  update: async (o) => { for (const [k, v] of Object.entries(o)) setAt(`${p}/${k}`, v); },
  remove: async () => setAt(p, null),
  transaction: async (fn) => { const cur = getAt(p); const r = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); if (r === undefined) return { committed: false }; setAt(p, r); return { committed: true }; }
}) };
const routes = {};
const fakeApp = { set() {}, use() {}, listen(port, cb) { cb && cb(); }, get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; } };
const fakeExpress = () => fakeApp; fakeExpress.json = () => () => {};
const pagamentos = [];
class FakePayment { async create({ body }) { pagamentos.push(body); return { id: 4242, status: 'approved', status_detail: 'accredited', transaction_amount: body.transaction_amount, point_of_interaction: { transaction_data: { qr_code: 'q', qr_code_base64: 'b' } } }; } async get() { return {}; } }
const mocks = {
  express: fakeExpress, cors: () => () => {}, helmet: () => () => {}, 'express-rate-limit': () => () => {}, dotenv: { config() {} },
  mercadopago: { MercadoPagoConfig: class {}, Payment: FakePayment },
  'firebase-admin': { initializeApp() {}, credential: { cert: () => ({}) }, database: () => fakeDb, auth: () => ({ verifyIdToken: async (t) => ({ uid: t }) }) }
};
const orig = Module._load; Module._load = function (req, ...a) { return mocks[req] || orig.call(this, req, ...a); };
const refunds = []; let respostaMP = { ok: true, status: 200, data: { id: 'RF1' } };
global.fetch = async (url, opts) => { refunds.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { ok: respostaMP.ok, status: respostaMP.status, json: async () => respostaMP.data }; };
require('../server.js');

const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, sendStatus(c) { r.code = c; return r; } }; return r; };
const call = async (key, { uid, body = {} }) => { const h = routes[key]; const res = mkRes(); await h[h.length - 1]({ body, query: {}, headers: {}, user: { uid } }, res, () => {}); return res; };

const novoPedido = (key, o = {}) => setAt(`pedidos/${key}`, { clienteUid: 'cli', lojaId: 'L1', status: 'Pendiente', numeroPedido: 'N1', subtotal: 50, precioEnvio: 6, desconto: 0, total: 56, cliente: { email: 'a@a.com' }, ...o });

(async () => {
  setAt('restaurantes/L1', { ownerUid: 'dono', activo: true });
  setAt('restaurantes_privado/L1', { mp_token: 'TOK', mp_oauth: true });
  setAt('config_plataforma/comissao/percentual', 10);

  // cartão: split de 10% sobre os produtos
  novoPedido('P1');
  let r = await call('POST /criar-pagamento-loja', { uid: 'cli', body: { lojaId: 'L1', pedidoKey: 'P1', token: 't', paymentMethodId: 'visa', installments: 1 } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(pagamentos.at(-1).application_fee, 5);
  assert.deepEqual([getAt('pedidos/P1/comissaoPlataforma/modo'), getAt('pedidos/P1/comissaoPlataforma/valor'), getAt('pedidos/P1/comissaoPlataforma/percentual')], ['split', 5, 10]);
  console.log('ok 3 cartão: application_fee = 10% dos produtos, gravado no pedido');

  // PIX com entrega grátis por presente/cupom (desconto = frete): base continua 50
  novoPedido('P2', { desconto: 6, total: 50 });
  r = await call('POST /criar-pix-loja', { uid: 'cli', body: { lojaId: 'L1', pedidoKey: 'P2', email: 'a@a.com' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(pagamentos.at(-1).application_fee, 5);
  console.log('ok 4 PIX: entrega grátis não reduz a base da comissão');

  // loja com token manual (legado): sem split, comissão "a_acertar"
  setAt('restaurantes_privado/L2', { mp_token: 'MANUAL' }); setAt('restaurantes/L2', { ownerUid: 'dono2', activo: true });
  novoPedido('P3', { lojaId: 'L2' });
  r = await call('POST /criar-pix-loja', { uid: 'cli', body: { lojaId: 'L2', pedidoKey: 'P3', email: 'a@a.com' } });
  assert.equal(r.code, 200);
  assert.equal(pagamentos.at(-1).application_fee, undefined);
  assert.equal(getAt('pedidos/P3/comissaoPlataforma/modo'), 'a_acertar');
  console.log('ok 5 token manual: sem split, registrada como a_acertar');

  // % zerada ou ausente: nada é cobrado nem registrado
  setAt('config_plataforma/comissao/percentual', 0);
  novoPedido('P4');
  await call('POST /criar-pix-loja', { uid: 'cli', body: { lojaId: 'L1', pedidoKey: 'P4', email: 'a@a.com' } });
  assert.equal(pagamentos.at(-1).application_fee, undefined); assert.equal(getAt('pedidos/P4/comissaoPlataforma'), undefined);
  setAt('config_plataforma', null);
  novoPedido('P5');
  await call('POST /criar-pix-loja', { uid: 'cli', body: { lojaId: 'L1', pedidoKey: 'P5', email: 'a@a.com' } });
  assert.equal(pagamentos.at(-1).application_fee, undefined);
  console.log('ok 6 sem % configurada: pagamento normal, sem comissão');

  // ---- reembolso ----
  const paga = (key, extra = {}) => novoPedido(key, { status: 'En preparación', pagoStatus: 'Aprobado', paymentStatusMP: 'approved', paymentIdMP: 777, ...extra });
  paga('R1', { reembolso: { status: 'aprovado', origem: 'loja', valor: 20, solicitadoEm: 'x' } });
  r = await call('POST /reembolso/executar', { uid: 'estranho', body: { pedidoKey: 'R1' } }); assert.equal(r.code, 403);
  r = await call('POST /reembolso/executar', { uid: 'cli', body: { pedidoKey: 'R1' } }); assert.equal(r.code, 403); // o cliente não devolve o próprio pedido
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'a/b' } }); assert.equal(r.code, 400);
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'NAOEXISTE' } }); assert.equal(r.code, 404);
  assert.equal(refunds.length, 0);
  console.log('ok 7 só o dono da loja executa a devolução');

  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R1' } });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.valor, 20);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].url, 'https://api.mercadopago.com/v1/payments/777/refunds');
  assert.equal(refunds[0].headers.Authorization, 'Bearer TOK'); assert.deepEqual(refunds[0].body, { amount: 20 });
  assert.equal(getAt('pedidos/R1/reembolso/execucao/status'), 'concluido'); assert.equal(getAt('pedidos/R1/reembolso/execucao/mpRefundId'), 'RF1');
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R1' } });
  assert.equal(r.code, 409); assert.equal(refunds.length, 1); // segunda chamada não devolve de novo
  console.log('ok 8 devolução parcial executada uma única vez, com o token da loja');

  // não aprovado, não pago online ou valor acima do total: recusa antes de chamar o MP
  paga('R2', { reembolso: { status: 'solicitado', origem: 'cliente', valor: 20 } });
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R2' } }); assert.equal(r.code, 409);
  paga('R3', { paymentIdMP: undefined, reembolso: { status: 'aprovado', origem: 'loja', valor: 20 } });
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R3' } }); assert.equal(r.code, 409);
  paga('R4', { reembolso: { status: 'aprovado', origem: 'loja', valor: 999 } });
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R4' } }); assert.equal(r.code, 400);
  assert.equal(refunds.length, 1);
  console.log('ok 9 não aprovado / sem pagamento online / valor acima do total');

  // falha no MP: registra "falhou" e permite tentar de novo
  paga('R5', { reembolso: { status: 'aprovado', origem: 'loja', valor: 30 } });
  respostaMP = { ok: false, status: 400, data: { message: 'Saldo insuficiente na conta.' } };
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R5' } });
  assert.equal(r.code, 502); assert.match(r.body.error, /Saldo insuficiente/);
  assert.equal(getAt('pedidos/R5/reembolso/execucao/status'), 'falhou');
  respostaMP = { ok: true, status: 200, data: { id: 'RF2' } };
  r = await call('POST /reembolso/executar', { uid: 'dono', body: { pedidoKey: 'R5' } });
  assert.equal(r.code, 200); assert.equal(getAt('pedidos/R5/reembolso/execucao/status'), 'concluido');
  console.log('ok 10 falha do Mercado Pago permite nova tentativa; sucesso trava');

  console.log('\nTODOS OS TESTES DE COMISSÃO E REEMBOLSO PASSARAM');
})().catch((e) => { console.error(e); process.exit(1); });
