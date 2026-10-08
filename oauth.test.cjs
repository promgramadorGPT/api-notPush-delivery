const Module = require('module');
const assert = require('assert');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
process.env.MP_CLIENT_ID = 'cid'; process.env.MP_CLIENT_SECRET = 'csec';
process.env.MP_OAUTH_REDIRECT_URI = 'https://api.test/oauth/mp/callback';
process.env.ALLOWED_ORIGINS = 'https://front.test';
process.env.PORT = '3999';

// ---- banco em memória ----
const store = {
  'restaurantes/loja1/ownerUid': 'dono1',
  'restaurantes/loja2/ownerUid': 'outro',
  'restaurantes_privado/loja1/mp_token': 'MANUAL'
};
const getAt = (p) => {
  if (p in store) return store[p];
  const pref = p + '/'; const out = {}; let any = false;
  for (const k of Object.keys(store)) if (k.startsWith(pref)) { any = true; out[k.slice(pref.length)] = store[k]; }
  return any ? out : null;
};
const fakeDb = { ref: (p) => ({
  once: async () => { const v = getAt(p); const c = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; return { val: () => c, exists: () => c !== null }; },
  set: async (v) => { store[p] = v; },
  remove: async () => { delete store[p]; },
  update: async (o) => { for (const [k, v] of Object.entries(o)) { if (v === null) delete store[`${p}/${k}`]; else store[`${p}/${k}`] = v; } },
  transaction: async () => {}
}) };
const routes = {};
const fakeApp = { set() {}, use() {}, listen(port, cb) { cb && cb(); },
  get: (p, ...h) => { routes['GET ' + p] = h; },
  post: (p, ...h) => { routes['POST ' + p] = h; } };
const fakeExpress = () => fakeApp; fakeExpress.json = () => () => {};
const mocks = {
  express: fakeExpress, cors: () => () => {}, helmet: () => () => {},
  'express-rate-limit': () => () => {}, dotenv: { config() {} },
  mercadopago: { MercadoPagoConfig: class {}, Payment: class {} },
  'firebase-admin': { initializeApp() {}, credential: { cert: () => ({}) },
    database: () => fakeDb, auth: () => ({ verifyIdToken: async (t) => ({ uid: t }) }) }
};
const orig = Module._load;
Module._load = function (req, ...a) { return mocks[req] || orig.call(this, req, ...a); };

// ---- fetch do Mercado Pago simulado ----
const chamadas = [];
let proximaResposta = null;
global.fetch = async (url, opts) => { chamadas.push({ url, body: JSON.parse(opts.body) }); const r = proximaResposta; return { ok: r.ok, status: r.status || 200, json: async () => r.data }; };

require(require('path').join(__dirname, '..', 'server.js'));

const mkRes = () => { const r = { code: 200, body: null, loc: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, redirect(c, l) { r.code = c; r.loc = l; return r; }, send(b) { r.body = b; return r; }, sendStatus(c) { r.code = c; return r; } }; return r; };
const call = async (key, { uid, body, query } = {}) => { const h = routes[key]; const res = mkRes(); const req = { body: body || {}, query: query || {}, headers: {}, user: uid ? { uid } : undefined }; await h[h.length - 1](req, res); return res; };

(async () => {
  // 1) iniciar: dono ok, não-dono 403, loja inválida 403
  let r = await call('POST /oauth/mp/iniciar', { uid: 'dono1', body: { lojaId: 'loja1' } });
  assert.equal(r.code, 200); const u = new URL(r.body.url);
  assert.equal(u.origin + u.pathname, 'https://auth.mercadopago.com.br/authorization');
  assert.equal(u.searchParams.get('client_id'), 'cid'); assert.equal(u.searchParams.get('redirect_uri'), 'https://api.test/oauth/mp/callback');
  const state = u.searchParams.get('state'); assert.match(state, /^[a-f0-9]{48}$/);
  assert.ok(store[`oauth_state/${state}`] || getAt(`oauth_state/${state}`));
  r = await call('POST /oauth/mp/iniciar', { uid: 'dono1', body: { lojaId: 'loja2' } }); assert.equal(r.code, 403);
  r = await call('POST /oauth/mp/iniciar', { uid: 'dono1', body: { lojaId: 'a/b' } }); assert.equal(r.code, 403);
  console.log('ok 1 iniciar (dono / não-dono / id malicioso)');

  // 2) callback com state desconhecido
  r = await call('GET /oauth/mp/callback', { query: { code: 'X', state: 'f'.repeat(48) } });
  assert.equal(r.code, 302); assert.match(r.loc, /mp=erro&motivo=expirado/);
  // 3) callback negado pelo lojista
  r = await call('GET /oauth/mp/callback', { query: { error: 'access_denied' } }); assert.match(r.loc, /motivo=negado/);
  console.log('ok 2/3 callback state inválido / negado');

  // 4) callback feliz
  proximaResposta = { ok: true, data: { access_token: 'APP_USR-tok', refresh_token: 'TG-ref', expires_in: 15552000, user_id: 777, public_key: 'APP_USR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
  r = await call('GET /oauth/mp/callback', { query: { code: 'CODE1', state } });
  assert.equal(r.loc, 'https://front.test/admin-loja.html?mp=ok');
  assert.deepEqual(chamadas[0].body, { client_id: 'cid', client_secret: 'csec', grant_type: 'authorization_code', code: 'CODE1', redirect_uri: 'https://api.test/oauth/mp/callback' });
  assert.equal(store['restaurantes_privado/loja1/mp_token'], 'APP_USR-tok');
  assert.equal(store['restaurantes_privado/loja1/mp_refresh_token'], 'TG-ref');
  assert.equal(store['restaurantes/loja1/mp_public_key'], 'APP_USR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(store['restaurantes/loja1/mp_conectado'], true);
  assert.ok(!('mp_token' in (getAt('restaurantes/loja1') || {})), 'token não pode ir para o nó público');
  assert.equal(getAt(`oauth_state/${state}`), null, 'state é de uso único');
  // reuso do mesmo state
  r = await call('GET /oauth/mp/callback', { query: { code: 'CODE1', state } }); assert.match(r.loc, /motivo=expirado/);
  console.log('ok 4 callback feliz grava token (privado) + public key (pública); state de uso único');

  // 5) status nunca vaza token
  r = await call('POST /oauth/mp/status', { uid: 'dono1', body: { lojaId: 'loja1' } });
  assert.equal(r.body.conectado, true); assert.equal(r.body.via, 'oauth'); assert.ok(!JSON.stringify(r.body).includes('APP_USR-tok'));
  r = await call('POST /oauth/mp/status', { uid: 'estranho', body: { lojaId: 'loja1' } }); assert.equal(r.code, 403);
  console.log('ok 5 status (sem vazar token; bloqueia estranho)');

  // 6) renovação: expira em 2 dias -> refresh usado ao obter token (via /status-loja não dá; testa via criar-pix path? usa função indireta)
  store['restaurantes_privado/loja1/mp_expires_at'] = Date.now() + 2 * 86400000;
  proximaResposta = { ok: true, data: { access_token: 'APP_USR-novo', refresh_token: 'TG-ref2', expires_in: 15552000, user_id: 777, public_key: 'APP_USR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
  // status-loja precisa de pagamentos/pedido; exercita getSellerToken pelo webhook-like caminho mais simples: criar-pagamento exige muito; então chama via rota /status-loja com dados mínimos
  store['pagamentos/PAY1/lojaId'] = 'loja1'; store['pagamentos/PAY1/pedidoKey'] = 'P1';
  store['pedidos/P1/clienteUid'] = 'cli'; store['pedidos/P1/lojaId'] = 'loja1';
  const n0 = chamadas.length;
  const rr = mkRes(); await routes['GET /status-loja/:lojaId/:paymentId'][1]({ params: { lojaId: 'loja1', paymentId: 'PAY1' }, user: { uid: 'cli' }, headers: {}, query: {}, body: {} }, rr);
  assert.equal(chamadas.length, n0 + 1, 'deveria ter chamado o refresh uma vez');
  assert.equal(chamadas[n0].body.grant_type, 'refresh_token'); assert.equal(chamadas[n0].body.refresh_token, 'TG-ref');
  assert.equal(store['restaurantes_privado/loja1/mp_token'], 'APP_USR-novo'); assert.equal(store['restaurantes_privado/loja1/mp_refresh_token'], 'TG-ref2');
  console.log('ok 6 renovação automática perto do vencimento (grava novo token e novo refresh_token)');

  // 7) token manual legado continua sendo usado sem chamar o MP
  store['restaurantes_privado/loja2/mp_token'] = 'LEGADO'; store['pagamentos/PAY2/lojaId'] = 'loja2'; store['pagamentos/PAY2/pedidoKey'] = 'P2';
  store['pedidos/P2/clienteUid'] = 'cli'; store['pedidos/P2/lojaId'] = 'loja2';
  const n1 = chamadas.length; const r3 = mkRes();
  await routes['GET /status-loja/:lojaId/:paymentId'][1]({ params: { lojaId: 'loja2', paymentId: 'PAY2' }, user: { uid: 'cli' }, headers: {}, query: {}, body: {} }, r3);
  assert.equal(chamadas.length, n1); // nenhum refresh
  console.log('ok 7 token manual (legado) segue funcionando, sem refresh');

  // 8) desconectar
  r = await call('POST /oauth/mp/desconectar', { uid: 'dono1', body: { lojaId: 'loja1' } });
  assert.equal(r.code, 200); assert.ok(!('restaurantes_privado/loja1/mp_token' in store)); assert.ok(!('restaurantes/loja1/mp_public_key' in store));
  console.log('ok 8 desconectar remove token e public key');
  console.log('\nTODOS OS TESTES DE OAUTH PASSARAM');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
