'use strict';
// V2.6 — Regras puras da gestão de entregadores (sem Firebase/Express). Usadas por server.js e testadas à parte.

const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;
const FORMAS_ACERTO = ['pix', 'dinheiro', 'outro'];
const MAX_LOTE = 100;          // taxas por acerto
const TAXA_MAX = 1000;

const limparTexto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Telefone só com dígitos (10 a 13). '' se vazio; null se inválido. */
function limparTelefone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length >= 10 && d.length <= 13 ? d : null;
}

/** Valida os campos editáveis do entregador. Devolve { campos } ou { erro }. Só inclui o que veio no corpo. */
function validarEdicao(body) {
  const campos = {};
  if (body?.nome !== undefined) {
    const n = limparTexto(body.nome, 80);
    if (n.length < 2) return { erro: 'Nome inválido.' };
    campos.nome = n;
  }
  if (body?.taxaPadrao !== undefined) {
    const t = Number(body.taxaPadrao);
    if (!Number.isFinite(t) || t < 0 || t > TAXA_MAX) return { erro: 'Taxa inválida.' };
    campos.taxaPadrao = arred(t);
  }
  if (body?.telefone !== undefined) {
    const f = limparTelefone(body.telefone);
    if (f === null) return { erro: 'Telefone inválido (use DDD + número).' };
    campos.telefone = f;
  }
  if (!Object.keys(campos).length) return { erro: 'Nada para alterar.' };
  return { campos };
}

/**
 * Do conjunto de taxas do entregador, escolhe as que podem ser pagas agora: da loja, ainda pendentes,
 * e (se vier lista) dentre as pedidas. `ignoradas` = pedidas que não puderam ser pagas (já pagas, de outra loja ou inexistentes).
 */
function selecionarPendentes(taxas, lojaId, pedidoKeys) {
  const todas = taxas || {};
  const pedidas = Array.isArray(pedidoKeys) ? [...new Set(pedidoKeys.map(String))] : null;
  const chaves = pedidas || Object.keys(todas);
  const pagaveis = [];
  let ignoradas = 0;
  for (const k of chaves) {
    const t = todas[k];
    if (t && t.lojaId === lojaId && t.statusPagamento !== 'pago' && Number.isFinite(Number(t.valor))) pagaveis.push({ pedidoKey: k, valor: arred(t.valor) });
    else if (pedidas) ignoradas++;
  }
  return { pagaveis, ignoradas, total: arred(pagaveis.reduce((s, x) => s + x.valor, 0)) };
}

/** Valida forma e observação do acerto. */
function validarAcerto(body) {
  const forma = String(body?.forma || '').toLowerCase();
  if (!FORMAS_ACERTO.includes(forma)) return { erro: 'Informe como o pagamento foi feito (PIX, dinheiro ou outro).' };
  const lista = body?.pedidoKeys;
  if (lista !== undefined && (!Array.isArray(lista) || lista.length === 0 || lista.length > MAX_LOTE)) return { erro: `Selecione de 1 a ${MAX_LOTE} taxas.` };
  return { forma, obs: limparTexto(body?.obs, 200), pedidoKeys: lista };
}

/** Registro do acerto (comprovante) a partir do que foi realmente pago. */
function montarAcerto({ lojaId, entregadorUid, entregadorNome, pagas, forma, obs, agora, criadoPor }) {
  return {
    lojaId, entregadorUid, entregador: limparTexto(entregadorNome, 80), forma, obs: obs || '',
    qtd: pagas.length, valorTotal: arred(pagas.reduce((s, x) => s + x.valor, 0)),
    pedidoKeys: pagas.map((x) => x.pedidoKey), criadoEm: agora, criadoPor
  };
}

/** Tentativas que sobram do código de entrega. */
const tentativasRestantes = (usadas, max) => Math.max(0, (Number(max) || 0) - (Number(usadas) || 0));

module.exports = { arred, FORMAS_ACERTO, MAX_LOTE, limparTexto, limparTelefone, validarEdicao, selecionarPendentes, validarAcerto, montarAcerto, tentativasRestantes };
