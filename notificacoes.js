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

module.exports = { ALIAS_EVENTO, EVENTOS_PEDIDO, normalizarEvento, ehEventoDePedido, resolverDestino, chaveEvento, montarAviso, urlDoApp, tokenValido, plataformaValida, tokensExcedentes, decidirReserva, criarLimitador, limparTexto };
