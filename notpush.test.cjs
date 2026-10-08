// NotPush V7 — regras puras e rotas (Firebase, Express e FCM simulados; sem rede).
const Module = require('module');
const assert = require('assert');
const crypto = require('crypto');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"yapoodbr-delivery"}';
process.env.EXPECTED_PROJECT_ID = 'yapoodbr-delivery';
process.env.APP_URL = 'https://app.exemplo.com.br';

// ---- 1) funções puras ----
const N = require('../notificacoes');
{
  assert.strictEqual(N.normalizarEvento('ACEITO'), 'aceptado'); assert.strictEqual(N.normalizarEvento('enviado'), 'despachado');
  assert.strictEqual(N.normalizarEvento('entregue'), 'entregue'); assert.strictEqual(N.normalizarEvento('x'), null); assert.strictEqual(N.normalizarEvento(), null);
  assert.strictEqual(N.urlDoApp('https://a.com', 'status.html?num=AB1'), 'https://a.com/status.html?num=AB1');
  assert.strictEqual(N.urlDoApp('https://a.com/app/', '/entregador.html'), 'https://a.com/app/entregador.html');
  assert.strictEqual(N.urlDoApp('', 'x.html'), '/x.html');
  assert.strictEqual(N.tokenValido('x'.repeat(30)), true); assert.strictEqual(N.tokenValido('curto'), false); assert.strictEqual(N.tokenValido('a b'.repeat(10)), false); assert.strictEqual(N.tokenValido(5), false);
  assert.strictEqual(N.plataformaValida('ios'), 'ios'); assert.strictEqual(N.plataformaValida('<script>'), 'web');
  assert.deepStrictEqual(N.tokensExcedentes({ a: { atualizadoEm: '2026-01-03' }, b: { atualizadoEm: '2026-01-01' }, c: { atualizadoEm: '2026-01-02' } }, 2), ['b']);
  assert.deepStrictEqual(N.tokensExcedentes({ a: {} }, 2), []);
  assert.strictEqual(N.decidirReserva(null, 1000).ok, true);
  assert.strictEqual(N.decidirReserva({ resultado: { enviados: 1 } }, 1000).motivo, 'duplicado');
  assert.strictEqual(N.decidirReserva({ resultado: { enviados: 0, semToken: true } }, 1000).ok, true);
  assert.strictEqual(N.decidirReserva({ reservadoEm: 990 }, 1000).motivo, 'em-andamento');
  assert.strictEqual(N.decidirReserva({ reservadoEm: 1 }, 100000).ok, true);
  let t = 0; const lim = N.criarLimitador(2, 1000, () => t);
  assert.deepStrictEqual([lim('a'), lim('a'), lim('a'), lim('b')], [true, true, false, true]); t = 1500; assert.strictEqual(lim('a'), true);
  assert.strictEqual(N.chaveEvento('atribuido', 'E1'), 'atribuido_E1'); assert.strictEqual(N.chaveEvento('novo', 'X'), 'novo');
  assert.strictEqual(N.montarAviso('atribuido', { pedido: { numeroPedido: 'AB12', bairro: 'Centro' } }).titulo, 'Nova entrega #AB12');
  assert.match(N.montarAviso('entregue', { pedido: { numeroPedido: 'AB12' } }).caminho, /status\.html\?num=AB12/);
  assert.match(N.montarAviso('bairro', { nomeBairro: 'Vila Nova' }).corpo, /Vila Nova/);
  const base = { pedido: { lojaId: 'L1', clienteUid: 'cli', status: 'En camino' }, loja: { ownerUid: 'dono' } };
  assert.strictEqual(N.resolverDestino('novo', { ...base, uid: 'cli' }).destinoUid, 'dono');
  assert.strictEqual(N.resolverDestino('novo', { ...base, uid: 'outro' }).status, 403);
  assert.strictEqual(N.resolverDestino('aceptado', { ...base, uid: 'cli' }).status, 403);
  assert.strictEqual(N.resolverDestino('aceptado', { ...base, uid: 'dono' }).destinoUid, 'cli');
  const ent = { entregadorUid: 'E1', lojaId: 'L1', entregaConfirmada: true };
  assert.strictEqual(N.resolverDestino('entregue', { ...base, uid: 'E1', entrega: ent }).destinoUid, 'cli');
  assert.strictEqual(N.resolverDestino('entregue', { ...base, uid: 'E2', entrega: ent }).status, 403);
  assert.strictEqual(N.resolverDestino('entregue', { ...base, uid: 'E1', entrega: { ...ent, entregaConfirmada: false } }).status, 409);
  assert.strictEqual(N.resolverDestino('atribuido', { ...base, uid: 'E1', entrega: ent }).status, 403);
  assert.strictEqual(N.resolverDestino('atribuido', { ...base, uid: 'dono', entrega: ent, entregador: { lojaId: 'L1', ativo: true } }).destinoUid, 'E1');
  assert.strictEqual(N.resolverDestino('atribuido', { ...base, uid: 'dono', entrega: ent, entregador: { lojaId: 'L1', ativo: false } }).status, 409);
  assert.strictEqual(N.resolverDestino('atribuido', { ...base, uid: 'dono', entrega: ent, entregador: { lojaId: 'L9', ativo: true } }).status, 409);
  assert.strictEqual(N.resolverDestino('atribuido', { ...base, uid: 'dono', entrega: null }).status, 409);
  console.log('ok 1 regras puras do NotPush');
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

(async () => {
  setAt('restaurantes/L1', { ownerUid: 'dono', nombre: 'Loja Um' });
  setAt('pedidos/P1', { lojaId: 'L1', clienteUid: 'cli', numeroPedido: 'AB12CD', status: 'Pendiente', bairro: 'Centro', tipoEntrega: 'delivery' });
  setAt('entregadores/E1', { lojaId: 'L1', ativo: true, nome: 'Ana' });

  // tokens
  assert.strictEqual((await call('POST /registrar-token', { uid: 'dono', body: { token: 'curto' } })).code, 400);
  assert.strictEqual((await call('POST /registrar-token', { uid: 'dono', body: { token: tk(1), plataforma: 'web' } })).code, 200);
  assert.strictEqual(getAt(`fcm_token_owner/${hash(tk(1))}`).uid, 'dono');
  // mesmo aparelho em outra conta: sai da conta anterior
  await call('POST /registrar-token', { uid: 'cli', body: { token: tk(1) } });
  assert.strictEqual(getAt(`fcm_tokens/dono/${hash(tk(1))}`), undefined);
  assert.strictEqual(getAt(`fcm_tokens/cli/${hash(tk(1))}`).uid, 'cli');
  assert.strictEqual(getAt(`fcm_token_owner/${hash(tk(1))}`).uid, 'cli');
  // limite de aparelhos por usuário (ficam os 10 mais novos)
  for (let i = 10; i < 25; i++) { setAt(`fcm_tokens/cheio/${hash(tk(i))}`, { token: tk(i), atualizadoEm: new Date(2026, 0, i).toISOString() }); }
  await call('POST /registrar-token', { uid: 'cheio', body: { token: tk(99) } });
  assert.strictEqual(Object.keys(getAt('fcm_tokens/cheio')).length, 10);
  assert.ok(getAt(`fcm_tokens/cheio/${hash(tk(99))}`), 'o novo permanece');
  assert.strictEqual(getAt(`fcm_tokens/cheio/${hash(tk(10))}`), undefined, 'o mais antigo saiu');
  // remover
  await call('POST /remover-token', { uid: 'cli', body: { token: tk(1) } });
  assert.strictEqual(getAt(`fcm_tokens/cli/${hash(tk(1))}`), undefined); assert.strictEqual(getAt(`fcm_token_owner/${hash(tk(1))}`), undefined);
  console.log('ok 2 tokens de aparelho (dono único, limite, remoção)');

  // novo pedido → dono; só o cliente do pedido
  await call('POST /registrar-token', { uid: 'dono', body: { token: tk(2) } });
  await call('POST /registrar-token', { uid: 'cli', body: { token: tk(3) } });
  await call('POST /registrar-token', { uid: 'E1', body: { token: tk(4) } });
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'estranho', body: { pedidoKey: 'P1', evento: 'novo' } })).code, 403);
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: 'P1', evento: 'xyz' } })).code, 400);
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: '../x', evento: 'novo' } })).code, 400);
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: 'NAO', evento: 'novo' } })).code, 404);
  let r = await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: 'P1', evento: 'novo' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.enviados, 1); assert.strictEqual(r.body.destinoUid, 'dono');
  let m = fcm.enviadas.at(-1);
  assert.strictEqual(m.token, tk(2)); assert.strictEqual(m.notification.title, 'Novo pedido'); assert.match(m.notification.body, /#AB12CD/);
  assert.strictEqual(m.data.url, 'https://app.exemplo.com.br/admin-loja.html'); assert.strictEqual(m.data.link, m.data.url);
  assert.strictEqual(m.webpush.fcmOptions.link, m.data.url); assert.strictEqual(m.webpush.notification.tag, m.data.tag); assert.strictEqual(m.webpush.headers.Urgency, 'high');
  assert.strictEqual(m.webpush.notification.icon, 'https://app.exemplo.com.br/icons/adm-192.png');
  assert.ok(Object.values(m.data).every((v) => typeof v === 'string'), 'data só com strings');
  // duplicado não envia de novo
  const antes = fcm.enviadas.length;
  r = await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: 'P1', evento: 'novo' } });
  assert.strictEqual(r.body.duplicado, true); assert.strictEqual(fcm.enviadas.length, antes);
  console.log('ok 3 novo pedido: destino, texto PT-BR, link, tag e sem duplicado');

  // duas chamadas ao mesmo tempo → um só envio
  fcm.atraso = 30; const a0 = fcm.enviadas.length;
  const [r1, r2] = await Promise.all([1, 2].map(() => call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P1', evento: 'aceito' } })));
  fcm.atraso = 0;
  assert.strictEqual(fcm.enviadas.length - a0, 1, 'envio único');
  assert.ok([r1, r2].some((x) => x.body.duplicado), 'a outra chamada foi barrada');
  m = fcm.enviadas.at(-1); assert.strictEqual(m.token, tk(3)); assert.strictEqual(m.data.url, 'https://app.exemplo.com.br/status.html?num=AB12CD');
  console.log('ok 4 chamadas simultâneas não duplicam o aviso');

  // sem aparelho: registra e permite tentar de novo depois
  setAt('pedidos/P2', { lojaId: 'L1', clienteUid: 'semtoken', numeroPedido: 'ZZ99ZZ', status: 'Pendiente' });
  r = await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P2', evento: 'despachado' } });
  assert.strictEqual(r.body.semToken, true);
  await call('POST /registrar-token', { uid: 'semtoken', body: { token: tk(5) } });
  r = await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P2', evento: 'enviado' } });
  assert.strictEqual(r.body.enviados, 1, 'depois que o aparelho registrou, o aviso sai');

  // token morto é removido
  fcm.falhar.add(tk(6)); await call('POST /registrar-token', { uid: 'semtoken', body: { token: tk(6) } });
  setAt('pedidos/P3', { lojaId: 'L1', clienteUid: 'semtoken', numeroPedido: 'MM11MM', status: 'Pendiente' });
  r = await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P3', evento: 'aceito' } });
  assert.deepStrictEqual([r.body.enviados, r.body.falhas, r.body.ok], [1, 1, false]);
  assert.strictEqual(getAt(`fcm_tokens/semtoken/${hash(tk(6))}`), undefined); assert.strictEqual(getAt(`fcm_token_owner/${hash(tk(6))}`), undefined);
  console.log('ok 5 sem aparelho e aparelho morto');

  // atribuido → entregador
  setAt('entregas/P1', { lojaId: 'L1', pedidoKey: 'P1', entregadorUid: 'E1', entregaConfirmada: false });
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'E1', body: { pedidoKey: 'P1', evento: 'atribuido' } })).code, 403);
  r = await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P1', evento: 'atribuido' } });
  assert.strictEqual(r.body.enviados, 1); m = fcm.enviadas.at(-1);
  assert.deepStrictEqual([m.token, m.notification.title, m.data.url], [tk(4), 'Nova entrega #AB12CD', 'https://app.exemplo.com.br/entregador.html']);
  assert.match(m.notification.body, /Centro/); assert.strictEqual(m.webpush.notification.icon, 'https://app.exemplo.com.br/icons/entregador-192.png');
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P1', evento: 'atribuido' } })).body.duplicado, true);
  // reatribuir a outro entregador é aviso novo
  setAt('entregadores/E2', { lojaId: 'L1', ativo: true }); await call('POST /registrar-token', { uid: 'E2', body: { token: tk(7) } });
  setAt('entregas/P1', { lojaId: 'L1', pedidoKey: 'P1', entregadorUid: 'E2', entregaConfirmada: false });
  r = await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P1', evento: 'atribuido' } });
  assert.strictEqual(r.body.enviados, 1); assert.strictEqual(fcm.enviadas.at(-1).token, tk(7));
  setAt('entregadores/E2', { lojaId: 'L1', ativo: false });
  setAt('entregas/P2', { lojaId: 'L1', pedidoKey: 'P2', entregadorUid: 'E2', entregaConfirmada: false });
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'dono', body: { pedidoKey: 'P2', evento: 'atribuido' } })).code, 409);
  console.log('ok 6 atribuição avisa o entregador (só o dono, só ativo, reatribuir reenvia)');

  // entregue → cliente (entregador da entrega ou dono; só se concluída)
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'E2', body: { pedidoKey: 'P1', evento: 'entregue' } })).code, 409); // ainda não confirmada
  setAt('entregas/P1', { lojaId: 'L1', pedidoKey: 'P1', entregadorUid: 'E2', entregaConfirmada: true });
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'E1', body: { pedidoKey: 'P1', evento: 'entregue' } })).code, 403);
  r = await call('POST /notificar-pedido', { uid: 'E2', body: { pedidoKey: 'P1', evento: 'entregue' } });
  assert.strictEqual(r.body.enviados, 1); m = fcm.enviadas.at(-1);
  assert.deepStrictEqual([m.token, m.notification.title], [tk(3), 'Pedido entregue']);
  console.log('ok 7 entrega concluída avisa o cliente');

  // bairro → dono
  setAt('bairros_sugeridos/L1/vilanova', { nome: 'Vila Nova', clienteUid: 'cli', status: 'pendente', criadoEm: 'x' });
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'outro', body: { evento: 'bairro', lojaId: 'L1', bairroId: 'vilanova' } })).code, 404);
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'cli', body: { evento: 'bairro', lojaId: 'L1', bairroId: '../x' } })).code, 400);
  r = await call('POST /notificar-pedido', { uid: 'cli', body: { evento: 'bairro', lojaId: 'L1', bairroId: 'vilanova' } });
  assert.strictEqual(r.body.enviados, 1); m = fcm.enviadas.at(-1);
  assert.deepStrictEqual([m.token, m.notification.title], [tk(2), 'Bairro novo']); assert.match(m.notification.body, /Vila Nova/);
  assert.strictEqual((await call('POST /notificar-pedido', { uid: 'cli', body: { evento: 'bairro', lojaId: 'L1', bairroId: 'vilanova' } })).body.duplicado, true);
  console.log('ok 8 bairro novo avisa o dono (só quem sugeriu, sem repetir)');

  // master
  setAt('admins/master1/role', 'master');
  assert.strictEqual((await call('POST /notificar-master', { uid: 'dono', body: { titulo: 'Oi', corpo: 'Promo' } })).code, 403);
  assert.strictEqual((await call('POST /notificar-master', { uid: 'master1', body: { titulo: 'Oi', corpo: 'Promo', link: 'javascript:alert(1)' } })).code, 400);
  assert.strictEqual((await call('POST /notificar-master', { uid: 'master1', body: { titulo: '  ', corpo: 'x' } })).code, 400);
  setAt('fcm_tokens/dup/' + hash(tk(2)), { token: tk(2), atualizadoEm: 'z' }); // mesmo token em duas contas
  const m0 = fcm.enviadas.length;
  r = await call('POST /notificar-master', { uid: 'master1', body: { titulo: 'Promo', corpo: 'Hoje tem desconto', link: '/index.html', campanhaId: 'c1' } });
  const tokensUnicos = new Set(Object.values(getAt('fcm_tokens')).flatMap((o) => Object.values(o).map((x) => x.token)));
  assert.strictEqual(fcm.enviadas.length - m0, tokensUnicos.size, 'cada aparelho recebe uma vez');
  assert.strictEqual(fcm.enviadas.at(-1).data.url, 'https://app.exemplo.com.br/index.html');
  assert.ok(getAt('notificaciones_master/c1'));
  console.log('ok 9 campanha do Master (valida link, não repete aparelho)');

  // erro interno não vaza detalhes
  const real = mocks['firebase-admin'].database; mocks['firebase-admin'].database = () => { throw new Error('segredo interno do banco'); };
  r = await call('POST /notificar-pedido', { uid: 'cli', body: { pedidoKey: 'P1', evento: 'novo' } });
  mocks['firebase-admin'].database = real;
  assert.strictEqual(r.code, 500); assert.ok(!/segredo/.test(JSON.stringify(r.body)));
  console.log('ok 10 erro interno sem vazar detalhes');
  console.log('TODOS OS TESTES DO NOTPUSH PASSARAM');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
