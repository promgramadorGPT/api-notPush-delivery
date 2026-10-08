'use strict';
// V7 — Regras puras do NotPush (sem Firebase/Express). Testadas em tests/notpush.test.cjs.

/** Nomes aceitos → chave gravada em notificaciones_pedidos (as antigas continuam as mesmas). */
const ALIAS_EVENTO = {
  novo: 'novo', aceptado: 'aceptado', aceito: 'aceptado', despachado: 'despachado', enviado: 'despachado',
  entregue: 'entregue', entregado: 'entregue', atribuido: 'atribuido', bairro: 'bairro'
};
const EVENTOS_PEDIDO = ['novo', 'aceptado', 'despachado', 'entregue', 'atribuido'];

const normalizarEvento = (e) => ALIAS_EVENTO[String(e || '').toLowerCase()] || null;
const ehEventoDePedido = (e) => EVENTOS_PEDIDO.includes(e);

/** Quem pode disparar cada evento e para quem vai. Devolve { destinoUid } ou { erro, status }. */
function resolverDestino(evento, { uid, pedido, loja, entrega, entregador }) {
  const dono = loja?.ownerUid;
  switch (evento) {
    case 'novo':
      if (pedido.clienteUid !== uid) return { erro: 'Usuário não é o cliente deste pedido.', status: 403 };
      return { destinoUid: dono };
    case 'aceptado':
    case 'despachado':
      if (dono !== uid) return { erro: 'Usuário não é proprietário da loja deste pedido.', status: 403 };
      return { destinoUid: pedido.clienteUid };
    case 'entregue': {
      const doEntregador = entrega && entrega.entregadorUid === uid && entrega.lojaId === pedido.lojaId;
      if (dono !== uid && !doEntregador) return { erro: 'Usuário não pode avisar a entrega deste pedido.', status: 403 };
      const concluida = (entrega && entrega.entregaConfirmada === true) || /entreg/i.test(String(pedido.status || ''));
      if (!concluida) return { erro: 'A entrega ainda não foi concluída.', status: 409 };
      return { destinoUid: pedido.clienteUid };
    }
    case 'atribuido':
      if (dono !== uid) return { erro: 'Usuário não é proprietário da loja deste pedido.', status: 403 };
      if (!entrega || !entrega.entregadorUid || entrega.lojaId !== pedido.lojaId) return { erro: 'Pedido sem entregador atribuído.', status: 409 };
      if (!entregador || entregador.ativo === false || entregador.lojaId !== pedido.lojaId) return { erro: 'Entregador inativo ou de outra loja.', status: 409 };
      return { destinoUid: entrega.entregadorUid };
    default:
      return { erro: 'Evento inválido.', status: 400 };
  }
}

/** Chave de controle de duplicidade. Reatribuir a outro entregador é um aviso novo. */
const chaveEvento = (evento, destinoUid) => (evento === 'atribuido' ? `atribuido_${destinoUid}` : evento);

const limparTexto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Título, corpo e caminho (relativo ao app) de cada aviso. */
function montarAviso(evento, { pedido = {}, nomeBairro = '' } = {}) {
  const num = pedido.numeroPedido ? ` #${limparTexto(pedido.numeroPedido, 20)}` : '';
  const q = pedido.numeroPedido ? `status.html?num=${encodeURIComponent(pedido.numeroPedido)}` : 'pedidos.html';
  switch (evento) {
    case 'novo': return { titulo: 'Novo pedido', corpo: `Você recebeu um novo pedido${num}.`, caminho: 'admin-loja.html', icone: 'icons/adm-192.png' };
    case 'aceptado': return { titulo: 'Pedido aceito', corpo: 'Seu pedido foi aceito pela loja.', caminho: q };
    case 'despachado': return { titulo: 'Pedido saiu para entrega', corpo: 'Seu pedido saiu para entrega.', caminho: q };
    case 'entregue': return { titulo: 'Pedido entregue', corpo: 'Bom apetite! Quando puder, avalie o seu pedido.', caminho: q };
    case 'atribuido': return { titulo: `Nova entrega${num}`, corpo: pedido.bairro ? `Bairro: ${limparTexto(pedido.bairro, 60)}. Abra o app para ver o endereço.` : 'Abra o app para ver o endereço.', caminho: 'entregador.html', icone: 'icons/entregador-192.png' };
    case 'bairro': return { titulo: 'Bairro novo', corpo: `Um cliente pediu em ${limparTexto(nomeBairro, 60)}. Defina a taxa para esse bairro.`, caminho: 'admin-loja.html', icone: 'icons/adm-192.png' };
    default: return null;
  }
}

/** URL absoluta dentro do app (APP_URL pode vir com ou sem barra final). Sem APP_URL válida, devolve o caminho relativo. */
function urlDoApp(base, caminho) {
  const c = String(caminho || '').replace(/^\/+/, '');
  try { return new URL(c, String(base).endsWith('/') ? base : base + '/').toString(); } catch { return '/' + c; }
}

/** Token FCM plausível (evita lixo no banco). */
const tokenValido = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 4096 && !/\s/.test(t);
const PLATAFORMAS = ['web', 'android', 'ios'];
const plataformaValida = (p) => (PLATAFORMAS.includes(p) ? p : 'web');

/** Do conjunto de tokens do usuário, devolve os ids que passam do limite (os mais antigos). */
function tokensExcedentes(tokensObj, max) {
  const lista = Object.entries(tokensObj || {}).map(([id, v]) => ({ id, t: String(v?.atualizadoEm || '') })).sort((a, b) => a.t.localeCompare(b.t));
  return lista.length > max ? lista.slice(0, lista.length - max).map((x) => x.id) : [];
}

/** Reserva do evento: decide se pode enviar agora, dada a situação gravada. Pura para a transação. */
function decidirReserva(atual, agora, janelaMs = 60000) {
  if (atual && atual.resultado && atual.resultado.enviados > 0) return { ok: false, motivo: 'duplicado' };
  if (atual && atual.reservadoEm && !atual.resultado && agora - atual.reservadoEm < janelaMs) return { ok: false, motivo: 'em-andamento' };
  return { ok: true };
}

/** Limitador simples por chave (em memória; suficiente para uma instância). */
function criarLimitador(max, janelaMs, relogio = Date.now) {
  const mapa = new Map();
  return (chave) => {
    const agora = relogio();
    const lista = (mapa.get(chave) || []).filter((t) => agora - t < janelaMs);
    if (lista.length >= max) { mapa.set(chave, lista); return false; }
    lista.push(agora); mapa.set(chave, lista);
    if (mapa.size > 5000) for (const [k, v] of mapa) if (!v.some((t) => agora - t < janelaMs)) mapa.delete(k);
    return true;
  };
}

// ---------------- V7.1 — Aviso automático de cupom ----------------
const LIMITE_DIARIO_PADRAO = 5000; // aparelhos por dia, somando todas as lojas (o Master pode mudar)
const MAX_PEDIDOS_PUBLICO = 2000;  // quantos pedidos recentes da loja entram na busca do público

/** Dia (YYYY-MM-DD) no horário de Brasília — o limite de "1 por dia" vira à meia-noite daqui. */
function diaBrasilia(agora = Date.now()) {
  return new Date(agora - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Configuração do Master (config_plataforma/push_cupom). Sem configuração: ligado, teto padrão. */
function configCupom(cfg) {
  const ativo = !(cfg && cfg.ativo === false);
  const bruto = cfg ? cfg.limiteDiario : undefined;
  const n = (bruto === undefined || bruto === null || bruto === '') ? NaN : Number(bruto);
  const limiteDiario = Number.isFinite(n) && n >= 0 ? Math.floor(n) : LIMITE_DIARIO_PADRAO;
  return { ativo, limiteDiario };
}

const reais = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
/** Só cupons ativos, com código válido e desconto de verdade. */
function cupomElegivel(c, agora = Date.now()) {
  if (!c || c.ativo === false) return false;
  // Validade (V7.1.1): cupom vencido ou ainda não iniciado não é divulgado. Datas AAAA-MM-DD, fim inclusivo (dia de Brasília).
  const hoje = diaBrasilia(agora), data = /^\d{4}-\d{2}-\d{2}$/;
  if (data.test(String(c.inicioEm || '')) && hoje < c.inicioEm) return false;
  if (data.test(String(c.fimEm || '')) && hoje > c.fimEm) return false;
  if (!/^[A-Z0-9_-]{3,20}$/.test(String(c.codigo || ''))) return false;
  if (c.tipo === 'porcentagem') return Number(c.valor) > 0 && Number(c.valor) <= 100;
  if (c.tipo === 'fixo') return Number(c.valor) > 0;
  return c.tipo === 'frete_gratis';
}

/** Texto fixo (a loja não escreve o texto: ninguém usa o app para mandar propaganda solta). */
function montarAvisoCupom({ lojaId, loja = {}, cupom = {} }) {
  const nome = limparTexto(loja.nombre || 'sua loja favorita', 40);
  const alvo = cupom.tipo === 'porcentagem' ? `${Number(cupom.valor)}% de desconto`
    : cupom.tipo === 'fixo' ? `${reais(cupom.valor)} de desconto` : 'Entrega grátis';
  const minimo = Number(cupom.minimo) > 0 ? ` em pedidos a partir de ${reais(cupom.minimo)}` : '';
  return {
    titulo: limparTexto(`🎟️ Cupom ${cupom.codigo} — ${nome}`, 100),
    corpo: limparTexto(`${alvo}${minimo}. Toque para aproveitar.`, 200),
    caminho: `restaurante.html?id=${encodeURIComponent(lojaId)}`
  };
}

/** Clientes distintos que já pediram na loja (pedidos recentes), sem os bloqueados. */
function publicoDaLoja(pedidosObj, bloqueados = {}) {
  const uids = new Set();
  for (const p of Object.values(pedidosObj || {})) {
    const u = p && p.clienteUid;
    if (typeof u === 'string' && u && !(bloqueados && bloqueados[u] != null)) uids.add(u);
  }
  return [...uids];
}

/** Quantos aparelhos ainda cabem no teto de hoje. */
const restanteDoDia = (limite, jaEnviados) => Math.max(0, limite - (Number(jaEnviados) || 0));

module.exports = { ALIAS_EVENTO, EVENTOS_PEDIDO, normalizarEvento, ehEventoDePedido, resolverDestino, chaveEvento, montarAviso, urlDoApp, tokenValido, plataformaValida, tokensExcedentes, decidirReserva, criarLimitador, limparTexto, diaBrasilia, configCupom, cupomElegivel, montarAvisoCupom, publicoDaLoja, restanteDoDia, LIMITE_DIARIO_PADRAO, MAX_PEDIDOS_PUBLICO };
