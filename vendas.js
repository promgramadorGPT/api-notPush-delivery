// NotPush V7.7 — contador de vendas do cardápio (restaurantes/{loja}/menu/{item}/vendas), feito pelo servidor.
// Conta os itens dos pedidos ENTREGUES (cancelado ou pendente não conta). Antes da V7.7 quem gravava era o painel da loja
// (só com o painel aberto e contando pedidos não entregues); agora as regras do Firebase deixam esse campo só para o servidor.
// Roda junto do agendador (POST /cron/ofertas e POST /cron/vendas, a cada 10 min):
//   1ª vez: recontagem completa (todos os pedidos) e grava o número certo em cada item;
//   depois: só os pedidos criados nos últimos JANELA_DIAS dias. Quem já foi contado fica em vendas_contagem/pedidos
//   (some depois de GUARDAR_DIAS); se um pedido contado for cancelado depois, a venda é desfeita.
const JANELA_DIAS = 7;
const GUARDAR_DIAS = 8;
const DIA = 86400000;
const ENTREGUE = new Set(["entregado", "entregue", "concluido", "concluído", "finalizado", "completado"]);
const CANCELADO = new Set(["cancelado", "cancelada"]);
const ID = /^[A-Za-z0-9_-]{1,80}$/;

const st = (s) => String(s || "").trim().toLowerCase();
const ehEntregue = (p) => !!p && ENTREGUE.has(st(p.status));
const ehCancelado = (p) => !!p && CANCELADO.has(st(p.status));
const msDe = (v) => { const n = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };

/** Itens do pedido → { itemId: quantidade } (ids válidos, quantidade inteira de 1 a 999; o mesmo item soma). */
function itensDoPedido(p) {
  const out = {};
  const lista = Array.isArray(p?.itens) ? p.itens : Object.values(p?.itens || {});
  for (const it of lista) {
    const id = it && typeof it.id === "string" ? it.id : "";
    const q = Math.floor(Number(it?.qtd) || 0);
    if (!ID.test(id) || q < 1) continue;
    out[id] = (out[id] || 0) + Math.min(999, q);
  }
  return out;
}
const lojaDoPedido = (p) => (p && typeof p.lojaId === "string" && ID.test(p.lojaId) ? p.lojaId : "");

/** Soma (ou subtrai, sinal = -1) os itens de um pedido em { loja: { item: n } }. */
function somar(acc, lojaId, itens, sinal = 1) {
  if (!lojaId) return acc;
  const l = (acc[lojaId] = acc[lojaId] || {});
  for (const [id, q] of Object.entries(itens)) l[id] = (l[id] || 0) + sinal * q;
  return acc;
}

/** Recontagem completa: { loja: { item: total } } só com pedidos entregues. */
function totaisEntregues(pedidos) {
  const acc = {};
  for (const p of Object.values(pedidos || {})) if (ehEntregue(p)) somar(acc, lojaDoPedido(p), itensDoPedido(p));
  return acc;
}

/**
 * Pedidos recentes → o que muda. `contados` = vendas_contagem/pedidos. Novo entregue soma; contado que virou cancelado desfaz.
 * → { deltas: { loja: { item: ±n } }, marcar: { pedidoId: registro | null } }
 */
function planejarRecentes(recentes, contados = {}) {
  const deltas = {}, marcar = {};
  for (const [pid, p] of Object.entries(recentes || {})) {
    if (!ID.test(pid) || !p) continue;
    const ja = contados[pid];
    if (ja && ehCancelado(p)) { somar(deltas, ja.l, ja.i || {}, -1); marcar[pid] = null; continue; }
    if (ja || !ehEntregue(p)) continue;
    const l = lojaDoPedido(p), i = itensDoPedido(p);
    if (!l || !Object.keys(i).length) continue;
    somar(deltas, l, i);
    marcar[pid] = { l, i, e: msDe(p.criadoEm) };
  }
  return { deltas, marcar };
}

/** Grava só em itens que existem no cardápio (nunca cria item "fantasma"); nunca fica negativo. */
function caminhosDoMenu(menus, valores, absoluto) {
  const up = {};
  for (const [lojaId, itens] of Object.entries(valores)) {
    const menu = menus[lojaId] || {};
    for (const [id, n] of Object.entries(itens)) {
      if (!menu[id] || typeof menu[id] !== "object") continue;
      const atual = Math.max(0, Math.floor(Number(menu[id].vendas) || 0));
      const novo = Math.max(0, absoluto ? n : atual + n);
      if (novo !== atual) up[`restaurantes/${lojaId}/menu/${id}/vendas`] = novo;
    }
  }
  return up;
}

/**
 * Roda a contagem. io = { ler(caminho), lerDesde(isoDesde) → pedidos criados desde a data, atualizar(updates na raiz),
 * travar(agora) → bool, destravar() }.
 */
async function contarVendas(io, agora = Date.now()) {
  if (!(await io.travar(agora))) return { ok: true, pulado: "em-andamento" };
  try {
    const estado = (await io.ler("vendas_contagem")) || {};
    const contados = estado.pedidos || {};
    const up = {};
    let modo, itensMudados;
    if (!estado.recontadoEm) {
      modo = "recontagem";
      const [pedidos, lojas] = await Promise.all([io.ler("pedidos"), io.ler("restaurantes")]);
      const totais = totaisEntregues(pedidos);
      const menus = {};
      for (const [lid, l] of Object.entries(lojas || {})) {
        if (!l || !l.menu) continue;
        menus[lid] = l.menu;
        totais[lid] = totais[lid] || {};
        for (const id of Object.keys(l.menu)) if (!(id in totais[lid])) totais[lid][id] = 0; // item sem venda entregue: zera
      }
      Object.assign(up, caminhosDoMenu(menus, totais, true));
      const desde = agora - JANELA_DIAS * DIA;
      for (const [pid, p] of Object.entries(pedidos || {})) {
        if (!ID.test(pid) || !ehEntregue(p) || msDe(p.criadoEm) < desde) continue;
        const l = lojaDoPedido(p), i = itensDoPedido(p);
        if (l && Object.keys(i).length) up[`vendas_contagem/pedidos/${pid}`] = { l, i, e: msDe(p.criadoEm) };
      }
      up["vendas_contagem/recontadoEm"] = agora;
    } else {
      modo = "recentes";
      const recentes = await io.lerDesde(new Date(agora - JANELA_DIAS * DIA).toISOString());
      const { deltas, marcar } = planejarRecentes(recentes, contados);
      const lojasMudadas = Object.keys(deltas);
      const menus = {};
      for (const lid of lojasMudadas) menus[lid] = (await io.ler(`restaurantes/${lid}/menu`)) || {};
      Object.assign(up, caminhosDoMenu(menus, deltas, false));
      for (const [pid, reg] of Object.entries(marcar)) up[`vendas_contagem/pedidos/${pid}`] = reg;
      for (const [pid, reg] of Object.entries(contados)) if (!(pid in marcar) && Number(reg?.e || 0) < agora - GUARDAR_DIAS * DIA) up[`vendas_contagem/pedidos/${pid}`] = null;
    }
    itensMudados = Object.keys(up).filter((k) => k.startsWith("restaurantes/")).length;
    up["vendas_contagem/ultimaEm"] = agora;
    up["vendas_contagem/ultimoResultado"] = { modo, itens: itensMudados, em: agora };
    await io.atualizar(up);
    return { ok: true, modo, itens: itensMudados };
  } finally {
    await io.destravar().catch(() => {});
  }
}

module.exports = { TRAVA_MS: 2 * 60000, contarVendas, itensDoPedido, totaisEntregues, planejarRecentes, caminhosDoMenu, ehEntregue, ehCancelado, JANELA_DIAS, GUARDAR_DIAS };
