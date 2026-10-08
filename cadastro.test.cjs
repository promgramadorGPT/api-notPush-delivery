// NotPush V7.3 — aviso do cadastro de lojista (Firebase, Express, FCM e e-mail simulados; sem rede).
const Module = require('module');
const assert = require('assert');
const crypto = require('crypto');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"yapoodbr-delivery"}';
process.env.EXPECTED_PROJECT_ID = 'yapoodbr-delivery';
process.env.APP_URL = 'https://app.exemplo.com.br';

// ---- 1) funções puras ----
const N = require('../notificacoes');
{
  const cad = { nomeCompleto: 'Maria da Silva', nomeLoja: 'Pastel da Maria', enviadoEm: '2026-10-08T12:00:00.000Z', analisadoEm: '2026-10-08T13:00:00.000Z' };
  assert.strictEqual(N.chaveCadastro('novo', cad), 'novo_20261008T120000000Z');
  assert.strictEqual(N.chaveCadastro('analisado', cad), 'analisado_20261008T130000000Z');
  assert.strictEqual(N.chaveCadastro('novo', {}), null);
  const novo = N.avisoCadastro('novo', cad);
  assert.strictEqual(novo.titulo, 'Novo cadastro de lojista'); assert.match(novo.corpo, /Pastel da Maria.*Maria da Silva/); assert.strictEqual(novo.caminho, 'master.html#cadastros');
  assert.strictEqual(N.avisoCadastro('analisado', { ...cad, status: 'aprovado' }).titulo, 'Cadastro aprovado! 🎉');
  const rec = N.avisoCadastro('analisado', { ...cad, status: 'recusado', motivoRecusa: 'Foto ilegível' });
  assert.match(rec.corpo, /Motivo: Foto ilegível/); assert.strictEqual(rec.caminho, 'admin-loja.html');
  const ea = N.emailCadastro({ ...cad, status: 'aprovado' }, 'https://app.exemplo.com.br');
  assert.match(ea.assunto, /aprovado/); assert.match(ea.texto, /^Olá, Maria!/); assert.match(ea.texto, /https:\/\/app\.exemplo\.com\.br\/admin-loja\.html/);
  const er = N.emailCadastro({ ...cad, status: 'recusado', motivoRecusa: 'Foto ilegível' }, '');
  assert.match(er.assunto, /não foi aprovado/); assert.match(er.texto, /Motivo: Foto ilegível/); assert.ok(!/http/.test(er.texto));
  console.log('ok 1 textos e chaves do cadastro');
}

// ---- 2) rotas ----
const tree = {};
const seg = (p) => p.split('/').filter(Boolean);
const getAt = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
const setAt = (p, v) => { const s = seg(p); let o = tree; s.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }); if (v === null || v === undefined) delete o[s[s.length - 1]]; else o[s[s.length - 1]] = JSON.parse(JSON.stringify(v)); };
const mkRef = (p) => ({
  once: async () => { const v = getAt(p); const c = v === undefined ? null : JSON.parse(JSON.stringify(v)); return { val: () => c, exists: () => c !== null }; },
  set: async (v) => setAt(p, v),
  remove: async () => setAt(p, null),
  orderByChild: (k) => ({ equalTo: (v) => ({ limitToLast: () => ({ once: async () => { const todos = getAt(p) || {}; const f = Object.fromEntries(Object.entries(todos).filter(([, x]) => x && x[k] === v)); return { val: () => (Object.keys(f).length ? f : null) }; } }) }) }),
  transaction: async (fn) => { const cur = getAt(p); const r = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); if (r === undefined) return { committed: false }; setAt(p, r); return { committed: true }; }
});
const fcm = { enviadas: [], falhar: new Set(), atraso: 0 };
const routes = {};
const fakeApp = { use() {}, listen() {}, get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; } };
const fakeExpress = () => fakeApp; fakeExpress.json = () => () => {};
const mocks = {
  express: fakeExpress, cors: () => () => {}, helmet: () => () => {},
  'firebase-admin': {
    initializeApp() {}, credential: { cert: () => ({}) }, database: () => ({ ref: mkRef }),
    auth: () => ({ verifyIdToken: async (t) => ({ uid: t }) }),
    messaging: () => ({
      send: async (m) => { if (fcm.atraso) await new Promise((r) => setTimeout(r, fcm.atraso)); if (fcm.falhar.has(m.token)) { const e = new Error('token morto'); e.code = 'messaging/registration-token-not-registered'; throw e; } fcm.enviadas.push(m); return 'msg-' + fcm.enviadas.length; },
      sendEach: async (ms) => ({ responses: ms.map((m) => { if (fcm.falhar.has(m.token)) return { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'x' } }; fcm.enviadas.push(m); return { success: true, messageId: 'm' }; }) })
    })
  }
};
const orig = Module._load; Module._load = function (req, ...a) { return mocks[req] || orig.call(this, req, ...a); };
require('../serve.js');
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = async (key, { uid, body = {} }) => { const h = routes[key]; assert.ok(h, 'rota ausente: ' + key); const res = mkRes(); await h[h.length - 1]({ body, headers: {}, user: { uid } }, res, () => {}); return res; };
const tk = (n) => 'token-' + String(n).padStart(3, '0') + '-' + 'x'.repeat(30);
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

const emails = []; let emailStatus = 200;
global.fetch = async (url, init) => { emails.push({ url, init, corpo: JSON.parse(init.body) }); return { ok: emailStatus === 200, status: emailStatus, text: async () => 'erro', json: async () => ({}) }; };
const getUser = { 'lojista': { email: 'maria@gmail.com' } };
mocks['firebase-admin'].auth = () => ({ verifyIdToken: async (t) => ({ uid: t }), getUser: async (u) => { if (!getUser[u]) throw new Error('sem usuário'); return getUser[u]; } });

(async () => {
  const cadBase = { status: 'pendente', nomeCompleto: 'Maria da Silva', nomeLoja: 'Pastel da Maria', email: 'cad@x.com', enviadoEm: '2026-10-08T12:00:00.000Z' };
  setAt('admins/M1', { role: 'master' }); setAt('admins/M2', { role: 'master' });
  await call('POST /registrar-token', { uid: 'M1', body: { token: tk(11) } });
  await call('POST /registrar-token', { uid: 'M2', body: { token: tk(12) } });
  await call('POST /registrar-token', { uid: 'lojista', body: { token: tk(13) } });
  const enviadasAntes = fcm.enviadas.length;

  // novo: só com cadastro pendente do próprio usuário
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'novo' } })).code, 404);
  setAt('lojistas_cadastro/lojista', cadBase);
  let r = await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'novo' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.masters, 2); assert.strictEqual(r.body.enviados, 2);
  const paraMasters = fcm.enviadas.slice(enviadasAntes);
  assert.deepStrictEqual(paraMasters.map((m) => m.token).sort(), [tk(11), tk(12)].sort());
  assert.strictEqual(paraMasters[0].notification.title, 'Novo cadastro de lojista');
  assert.strictEqual(paraMasters[0].data.url, 'https://app.exemplo.com.br/master.html#cadastros');
  // repetir não avisa de novo; reenviar o cadastro (nova data) avisa
  r = await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'novo' } }); assert.strictEqual(r.body.duplicado, true);
  assert.strictEqual(fcm.enviadas.length, enviadasAntes + 2);
  setAt('lojistas_cadastro/lojista', { ...cadBase, enviadoEm: '2026-10-09T12:00:00.000Z' });
  r = await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'novo' } }); assert.strictEqual(r.body.enviados, 2);
  // cadastro já decidido não dispara "novo"
  setAt('lojistas_cadastro/lojista/status', 'aprovado');
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'novo' } })).code, 404);
  console.log('ok 2 aviso "novo cadastro" aos Masters (1 vez por envio)');

  // analisado: só o Master, só cadastro decidido
  setAt('lojistas_cadastro/lojista', { ...cadBase, status: 'pendente' });
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'lojista', body: { evento: 'analisado', uid: 'lojista' } })).code, 403);
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: '../x' } })).code, 400);
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } })).code, 409);
  assert.strictEqual((await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'xyz' } })).code, 400);
  setAt('lojistas_cadastro/lojista', { ...cadBase, status: 'aprovado', analisadoEm: '2026-10-09T13:00:00.000Z', analisadoPor: 'M1' });
  // sem e-mail configurado: só o push
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
  const antes = fcm.enviadas.length;
  r = await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.push.enviados, 1); assert.strictEqual(r.body.email.enviado, false); assert.match(r.body.email.motivo, /não configurado/);
  const m = fcm.enviadas.at(-1); assert.strictEqual(m.token, tk(13)); assert.strictEqual(m.notification.title, 'Cadastro aprovado! 🎉'); assert.strictEqual(fcm.enviadas.length, antes + 1);
  assert.strictEqual(emails.length, 0);
  console.log('ok 3 aprovação avisa o lojista por push (e-mail desligado sem chave)');

  // com e-mail configurado: sai uma vez; push não repete
  process.env.RESEND_API_KEY = 're_teste'; process.env.EMAIL_FROM = 'YaPOOD <nao-responda@exemplo.com.br>';
  r = await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } });
  assert.strictEqual(r.body.email.enviado, true); assert.strictEqual(r.body.push.duplicado, true); assert.strictEqual(fcm.enviadas.length, antes + 1);
  assert.strictEqual(emails.length, 1); assert.strictEqual(emails[0].url, 'https://api.resend.com/emails');
  assert.strictEqual(emails[0].init.headers.Authorization, 'Bearer re_teste');
  assert.deepStrictEqual(emails[0].corpo.to, ['maria@gmail.com']); assert.match(emails[0].corpo.subject, /aprovado/); assert.match(emails[0].corpo.text, /admin-loja\.html/);
  r = await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } });
  assert.strictEqual(r.body.email.duplicado, true); assert.strictEqual(emails.length, 1);
  console.log('ok 4 e-mail da decisão sai uma vez');

  // nova decisão (recusa) com e-mail do serviço falhando: libera nova tentativa
  setAt('lojistas_cadastro/lojista', { ...cadBase, status: 'recusado', motivoRecusa: 'Foto ilegível', analisadoEm: '2026-10-10T13:00:00.000Z', analisadoPor: 'M1' });
  emailStatus = 500;
  r = await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } });
  assert.strictEqual(r.body.email.enviado, false); assert.match(r.body.email.motivo, /recusou \(500\)/); assert.strictEqual(r.body.push.enviados, 1);
  assert.strictEqual(fcm.enviadas.at(-1).notification.title, 'Cadastro não aprovado'); assert.match(fcm.enviadas.at(-1).notification.body, /Foto ilegível/);
  emailStatus = 200;
  r = await call('POST /notificar-cadastro', { uid: 'M1', body: { evento: 'analisado', uid: 'lojista' } });
  assert.strictEqual(r.body.email.enviado, true); assert.match(emails.at(-1).corpo.text, /Motivo: Foto ilegível/);
  console.log('ok 5 recusa: push + e-mail com nova tentativa quando o serviço falha');
  console.log('TODOS OS TESTES DO CADASTRO PASSARAM');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
