// V2.6 — entregadores: helpers puros + rotas (Firebase, Express e MP simulados; sem rede).
const Module = require('module');
const assert = require('assert');
const crypto = require('crypto');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
process.env.PORT = '3997';
process.env.PIN_SECRET = 'segredo-de-teste-123456';

// ---- 1) funções puras ----
const EN = require('../entregadores');
{
  assert.strictEqual(EN.limparTelefone(''), ''); assert.strictEqual(EN.limparTelefone('(34) 99999-0000'), '34999990000');
  assert.strictEqual(EN.limparTelefone('123'), null); assert.strictEqual(EN.limparTelefone('1'.repeat(14)), null);
  assert.deepStrictEqual(EN.validarEdicao({ nome: '  Ana   Maria ', taxaPadrao: '6.5', telefone: '34 99999-0000' }).campos, { nome: 'Ana Maria', taxaPadrao: 6.5, telefone: '34999990000' });
  assert.deepStrictEqual(EN.validarEdicao({ taxaPadrao: 0 }).campos, { taxaPadrao: 0 });
  for (const ruim of [{}, { nome: 'A' }, { taxaPadrao: -1 }, { taxaPadrao: 1001 }, { taxaPadrao: 'x' }, { telefone: '12' }]) assert.ok(EN.validarEdicao(ruim).erro, JSON.stringify(ruim));
  const taxas = { A: { lojaId: 'L1', valor: 5, statusPagamento: 'pendente' }, B: { lojaId: 'L1', valor: 7.5, statusPagamento: 'pendente' }, C: { lojaId: 'L1', valor: 3, statusPagamento: 'pago' }, D: { lojaId: 'L2', valor: 9, statusPagamento: 'pendente' } };
  let s = EN.selecionarPendentes(taxas, 'L1');
  assert.deepStrictEqual([s.pagaveis.map(x => x.pedidoKey), s.total, s.ignoradas], [['A', 'B'], 12.5, 0]);
  s = EN.selecionarPendentes(taxas, 'L1', ['A', 'C', 'D', 'Z', 'A']);
  assert.deepStrictEqual([s.pagaveis.map(x => x.pedidoKey), s.total, s.ignoradas], [['A'], 5, 3]);
  assert.strictEqual(EN.validarAcerto({ forma: 'cheque' }).erro !== undefined, true);
  assert.strictEqual(EN.validarAcerto({ forma: 'PIX', obs: ' ok ' }).forma, 'pix');
  assert.ok(EN.validarAcerto({ forma: 'pix', pedidoKeys: [] }).erro);
  assert.ok(EN.validarAcerto({ forma: 'pix', pedidoKeys: Array(101).fill('x') }).erro);
  const a = EN.montarAcerto({ lojaId: 'L1', entregadorUid: 'E1', entregadorNome: 'Ana', pagas: [{ pedidoKey: 'A', valor: 5 }, { pedidoKey: 'B', valor: 7.5 }], forma: 'pix', obs: '', agora: 1, criadoPor: 'dono' });
  assert.deepStrictEqual([a.qtd, a.valorTotal, a.pedidoKeys], [2, 12.5, ['A', 'B']]);
  assert.strictEqual(EN.tentativasRestantes(2, 5), 3); assert.strictEqual(EN.tentativasRestantes(9, 5), 0);
  console.log('ok 1 helpers puros de entregadores');
}

// ---- 2) rotas ----
const tree = {};
const seg = (p) => p.split('/').filter(Boolean);
const getAt = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
const setAt = (p, v) => { const s = seg(p); let o = tree; s.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }); if (v === null || v === undefined) delete o[s[s.length - 1]]; else o[s[s.length - 1]] = JSON.parse(JSON.stringify(v)); };
let seq = 0;
const mkRef = (p) => ({
  key: seg(p).at(-1),
  once: async () => { const v = getAt(p); const c = v === undefined ? null : JSON.parse(JSON.stringify(v)); return { val: () => c, exists: () => c !== null, ref: mkRef(p) }; },
  set: async (v) => setAt(p, v),
  update: async (o) => { for (const [k, v] of Object.entries(o)) setAt(`${p}/${k}`, v); },
  remove: async () => setAt(p, null),
  child: (c) => mkRef(`${p}/${c}`),
  push: () => mkRef(`${p}/-K${String(++seq).padStart(4, '0')}`),
  orderByChild: (campo) => ({ equalTo: (valor) => ({ once: async () => {
    const filhos = getAt(p) || {}; const r = {};
    for (const [k, v] of Object.entries(filhos)) if (v && v[campo] === valor) r[k] = v;
    const c = Object.keys(r).length ? JSON.parse(JSON.stringify(r)) : null; return { val: () => c, exists: () => c !== null };
  } }) }),
  transaction: async (fn) => { const cur = getAt(p); const r = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur))); if (r === undefined) return { committed: false }; setAt(p, r); return { committed: true }; }
});
const fakeDb = { ref: mkRef };
const routes = {};
const fakeApp = { set() {}, use() {}, listen(port, cb) { cb && cb(); }, get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; } };
const fakeExpress = () => fakeApp; fakeExpress.json = () => () => {};
const mocks = {
  express: fakeExpress, cors: () => () => {}, helmet: () => () => {}, 'express-rate-limit': () => () => {}, dotenv: { config() {} },
  mercadopago: { MercadoPagoConfig: class {}, Payment: class {} },
  'firebase-admin': { initializeApp() {}, credential: { cert: () => ({}) }, database: () => fakeDb, auth: () => ({ verifyIdToken: async (t) => ({ uid: t }) }) }
};
const orig = Module._load; Module._load = function (req, ...a) { return mocks[req] || orig.call(this, req, ...a); };
require('../server.js');
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, sendStatus(c) { r.code = c; return r; } }; return r; };
const call = async (key, { uid, body = {} }) => { const h = routes[key]; assert.ok(h, 'rota ausente: ' + key); const res = mkRes(); await h[h.length - 1]({ body, query: {}, headers: {}, user: { uid } }, res, () => {}); return res; };

(async () => {
  setAt('restaurantes/L1', { ownerUid: 'dono', nombre: 'Loja Um', telefono: '3433334444', whatsapp: '(34) 99999-1111' });
  setAt('restaurantes/L2', { ownerUid: 'dono2' });
  setAt('entregadores/E1', { lojaId: 'L1', nome: 'Ana', email: 'ana@x.com', taxaPadrao: 5, ativo: true });
  setAt('entregadores/E2', { lojaId: 'L2', nome: 'Beto', email: 'beto@x.com', taxaPadrao: 4, ativo: true });
  const pedido = (k, extra = {}) => setAt(`pedidos/${k}`, { lojaId: 'L1', status: 'En camino', numeroPedido: 'N' + k, tipoEntrega: 'delivery', cliente: { nombre: 'Cli ' + k, telefono: '34988887777', direccion: 'Rua ' + k + ', 10 - Centro' }, bairro: 'Centro', itens: [], total: 30, ...extra });
  for (const k of ['P1', 'P2', 'P3', 'P5']) pedido(k);
  pedido('P4', { lojaId: 'L2' });
  const entrega = (k, uid, extra = {}) => { setAt(`entregas/${k}`, { lojaId: uid === 'E2' ? 'L2' : 'L1', pedidoKey: k, entregadorUid: uid, taxaEntregador: 5, atribuidaEm: 1000 + Number(k.slice(1)), entregaConfirmada: false, ...extra }); setAt(`entregas_por_entregador/${uid}/${k}`, true); };
  entrega('P1', 'E1', { entregaConfirmada: true, confirmadaEm: 2000 }); entrega('P2', 'E1', { entregaConfirmada: true, confirmadaEm: 2001, taxaEntregador: 7.5 });
  entrega('P3', 'E1', { entregaConfirmada: true, confirmadaEm: 2002, taxaEntregador: 3 }); entrega('P5', 'E1'); entrega('P4', 'E2');
  const taxa = (uid, k, valor, status, loja = 'L1') => setAt(`taxas_entregador/${uid}/${k}`, { lojaId: loja, pedidoKey: k, entregadorUid: uid, valor, criadoEm: 3000 + Number(k.slice(1)), statusPagamento: status });
  taxa('E1', 'P1', 5, 'pendente'); taxa('E1', 'P2', 7.5, 'pendente'); taxa('E1', 'P3', 3, 'pago'); taxa('E2', 'P4', 4, 'pendente', 'L2');

  // convidar
  let r = await call('POST /entregador/convidar', { uid: 'dono', body: { lojaId: 'L1', email: 'novo@x.com', nome: ' Carla  ', taxa: 6, telefone: '(34) 98888-7777' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const conv = getAt('entregadores_convites/novo@x,com') || getAt('entregadores_convites/novo@x.com');
  assert.deepStrictEqual([conv.nome, conv.telefone, conv.taxaPadrao], ['Carla', '34988887777', 6]);
  assert.strictEqual((await call('POST /entregador/convidar', { uid: 'dono', body: { lojaId: 'L1', email: 'ANA@x.com', taxa: 1 } })).code, 409); // já é entregador da loja
  assert.strictEqual((await call('POST /entregador/convidar', { uid: 'dono2', body: { lojaId: 'L2', email: 'novo@x.com', taxa: 1 } })).code, 409); // convite de outra loja
  assert.strictEqual((await call('POST /entregador/convidar', { uid: 'dono', body: { lojaId: 'L1', email: 'x@x.com', taxa: 1, telefone: '12' } })).code, 400);
  assert.strictEqual((await call('POST /entregador/convidar', { uid: 'estranho', body: { lojaId: 'L1', email: 'y@x.com', taxa: 1 } })).code, 403);
  assert.strictEqual((await call('POST /entregador/convidar', { uid: 'dono', body: { lojaId: 'L1', email: 'novo@x.com', taxa: 8 } })).code, 200); // reenviar atualiza
  r = await call('POST /entregador/listar', { uid: 'dono', body: { lojaId: 'L1' } });
  assert.deepStrictEqual([r.body.entregadores.length, r.body.convites.length, r.body.convites[0].email], [1, 1, 'novo@x.com']);
  r = await call('POST /entregador/cancelar-convite', { uid: 'dono2', body: { lojaId: 'L2', email: 'novo@x.com' } }); assert.strictEqual(r.code, 404);
  r = await call('POST /entregador/cancelar-convite', { uid: 'dono', body: { lojaId: 'L1', email: 'novo@x.com' } }); assert.strictEqual(r.code, 200);
  assert.strictEqual((await call('POST /entregador/listar', { uid: 'dono', body: { lojaId: 'L1' } })).body.convites.length, 0);
  console.log('ok 2 convidar (telefone, duplicidade) e cancelar convite');

  // editar
  r = await call('POST /entregador/editar', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', nome: 'Ana Paula', taxaPadrao: 6, telefone: '(34) 97777-6666' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual([getAt('entregadores/E1/nome'), getAt('entregadores/E1/taxaPadrao'), getAt('entregadores/E1/telefone'), getAt('entregadores/E1/email')], ['Ana Paula', 6, '34977776666', 'ana@x.com']);
  assert.strictEqual((await call('POST /entregador/editar', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E2', nome: 'Hack' } })).code, 404); // de outra loja
  assert.strictEqual((await call('POST /entregador/editar', { uid: 'dono2', body: { lojaId: 'L1', entregadorUid: 'E1', nome: 'Hack' } })).code, 403);
  assert.strictEqual((await call('POST /entregador/editar', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', taxaPadrao: -3 } })).code, 400);
  assert.strictEqual(getAt('entregadores/E1/taxaPadrao'), 6);
  console.log('ok 3 editar entregador (só campos válidos, só o dono)');

  // entregas da loja
  r = await call('POST /entregador/entregas', { uid: 'dono', body: { lojaId: 'L1' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.entregas.map(x => x.pedidoKey), ['P5', 'P3', 'P2', 'P1']);          // só da loja L1, mais recentes primeiro
  const e5 = r.body.entregas[0];
  assert.deepStrictEqual([e5.entregador, e5.confirmada, e5.cancelado, e5.endereco, e5.bairro, e5.taxa], ['Ana Paula', false, false, 'Rua P5, 10 - Centro', 'Centro', 5]);
  assert.strictEqual((await call('POST /entregador/entregas', { uid: 'estranho', body: { lojaId: 'L1' } })).code, 403);
  console.log('ok 4 /entregador/entregas (rota que faltava) devolve só as entregas da loja');

  // desatribuir
  assert.strictEqual((await call('POST /entregador/desatribuir', { uid: 'dono', body: { lojaId: 'L1', pedidoKey: 'P1' } })).code, 409);   // já confirmada
  assert.strictEqual((await call('POST /entregador/desatribuir', { uid: 'dono', body: { lojaId: 'L1', pedidoKey: 'P4' } })).code, 404);   // outra loja
  assert.strictEqual((await call('POST /entregador/desatribuir', { uid: 'dono2', body: { lojaId: 'L1', pedidoKey: 'P5' } })).code, 403);
  assert.strictEqual((await call('POST /entregador/desatribuir', { uid: 'dono', body: { lojaId: 'L1', pedidoKey: 'a/b' } })).code, 400);
  assert.strictEqual((await call('POST /entregador/desatribuir', { uid: 'dono', body: { lojaId: 'L1', pedidoKey: 'P5' } })).code, 200);
  assert.deepStrictEqual([getAt('entregas/P5'), getAt('entregas_por_entregador/E1/P5')], [undefined, undefined]);
  console.log('ok 5 desatribuir (só entrega não confirmada da própria loja)');

  // pagar em lote
  assert.strictEqual((await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'cheque' } })).code, 400);
  assert.strictEqual((await call('POST /entregador/pagar-lote', { uid: 'dono2', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'pix' } })).code, 403);
  assert.strictEqual((await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E2', forma: 'pix' } })).code, 404);
  r = await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'pix', obs: 'semana 1', pedidoKeys: ['P1', 'P3', 'P4', 'XX'] } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.qtd, r.body.valorTotal, r.body.ignoradas], [1, 5, 3]);              // P3 já paga, P4 de outra loja, XX inexistente
  assert.deepStrictEqual([getAt('taxas_entregador/E1/P1/statusPagamento'), getAt('taxas_entregador/E1/P2/statusPagamento'), getAt('taxas_entregador/E2/P4/statusPagamento')], ['pago', 'pendente', 'pendente']);
  const ac1 = getAt('acertos_entregador/E1/' + r.body.acertoId);
  assert.deepStrictEqual([ac1.forma, ac1.obs, ac1.qtd, ac1.valorTotal, ac1.pedidoKeys, ac1.entregador, ac1.criadoPor], ['pix', 'semana 1', 1, 5, ['P1'], 'Ana Paula', 'dono']);
  assert.strictEqual(getAt('taxas_entregador/E1/P1/acertoId'), r.body.acertoId);
  assert.strictEqual((await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'pix', pedidoKeys: ['P1'] } })).code, 409); // não paga de novo
  r = await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'dinheiro' } });   // tudo que está pendente
  assert.deepStrictEqual([r.code, r.body.qtd, r.body.valorTotal], [200, 1, 7.5]);
  assert.strictEqual((await call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'dinheiro' } })).code, 409);
  console.log('ok 6 pagar em lote: só pendentes da loja, comprovante gravado, sem pagar duas vezes');

  // concorrência: duas chamadas ao mesmo tempo não pagam a mesma taxa duas vezes
  taxa('E1', 'P6', 10, 'pendente'); taxa('E1', 'P7', 20, 'pendente');
  const [a, b] = await Promise.all([1, 2].map(() => call('POST /entregador/pagar-lote', { uid: 'dono', body: { lojaId: 'L1', entregadorUid: 'E1', forma: 'pix', pedidoKeys: ['P6', 'P7'] } })));
  const oks = [a, b].filter(x => x.code === 200);
  assert.ok(oks.length >= 1);
  const somaAcertos = Object.values(getAt('acertos_entregador/E1')).filter(x => x.pedidoKeys.some(k => k === 'P6' || k === 'P7')).reduce((s, x) => s + x.valorTotal, 0);
  assert.strictEqual(somaAcertos, 30);                                                                  // 10 + 20 contados uma única vez (mesmo dividido entre os dois acertos)
  const qtdPagas = Object.values(getAt('acertos_entregador/E1')).reduce((n, x) => n + x.pedidoKeys.filter(k => k === 'P6' || k === 'P7').length, 0);
  assert.strictEqual(qtdPagas, 2);                                                                      // cada taxa aparece em um único comprovante
  console.log('ok 7 chamadas simultâneas não duplicam o pagamento');

  // acertos
  r = await call('POST /entregador/acertos', { uid: 'dono', body: { lojaId: 'L1' } });
  assert.strictEqual(r.code, 200); assert.ok(r.body.acertos.length >= 3);
  assert.ok(r.body.acertos.every(x => x.entregador === 'Ana Paula'));
  assert.strictEqual((await call('POST /entregador/acertos', { uid: 'dono2', body: { lojaId: 'L1' } })).code, 403);
  assert.strictEqual((await call('POST /entregador/acertos', { uid: 'dono2', body: { lojaId: 'L2' } })).body.acertos.length, 0);
  console.log('ok 8 histórico de pagamentos (acertos) por loja');

  // taxas devolve pagoEm/acertoId
  r = await call('POST /entregador/taxas', { uid: 'dono', body: { lojaId: 'L1' } });
  const t1 = r.body.taxas.find(x => x.pedidoKey === 'P1'); assert.ok(t1.pagoEm && t1.acertoId);
  assert.ok(!r.body.taxas.some(x => x.pedidoKey === 'P4'));

  // app do entregador: /minhas e tentativas restantes
  entrega('P8', 'E1'); pedido('P8');
  r = await call('POST /entregador/minhas', { uid: 'E1' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.loja.nome, r.body.loja.telefone], ['Loja Um', '34999991111']);
  assert.ok(r.body.acertos.length >= 3 && r.body.acertos[0].valorTotal > 0);
  assert.strictEqual(r.body.entregas.find(x => x.pedidoKey === 'P8').tentativasRestantes, 5);
  assert.ok(r.body.taxas.find(x => x.pedidoKey === 'P1').pagoEm);
  const certo = String(parseInt(crypto.createHmac('sha256', process.env.PIN_SECRET).update('P8').digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0');
  const errado = certo === '0000' ? '1111' : '0000';
  r = await call('POST /entregador/validar-codigo', { uid: 'E1', body: { pedidoKey: 'P8', codigo: errado } });
  assert.deepStrictEqual([r.code, r.body.restantes], [403, 4]);
  r = await call('POST /entregador/validar-codigo', { uid: 'E1', body: { pedidoKey: 'P8', codigo: errado } });
  assert.strictEqual(r.body.restantes, 3);
  assert.strictEqual((await call('POST /entregador/minhas', { uid: 'E1' })).body.entregas.find(x => x.pedidoKey === 'P8').tentativasRestantes, 3);
  r = await call('POST /entregador/validar-codigo', { uid: 'E1', body: { pedidoKey: 'P8', codigo: certo } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(getAt('taxas_entregador/E1/P8/statusPagamento'), 'pendente');
  console.log('ok 9 app do entregador: loja, pagamentos recebidos e tentativas restantes do código');
  console.log('TODOS OS TESTES DE ENTREGADORES PASSARAM');
})().catch((e) => { console.error(e); process.exit(1); });
