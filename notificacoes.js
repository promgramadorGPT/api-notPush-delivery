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


// ---------- Presente fidelidade (V7.2) ----------
// Espelha js/fidelidade.js do app (configFidelidade/pedidoConta). O aviso NÃO revela o presente: é uma surpresa aberta no app.
const entregueSt = (st) => /^(entregado|entregue|concluido|concluído|finalizado|completado)$/i.test(String(st || '').trim());
const TIPOS_FIDELIDADE = ['frete_gratis', 'fixo', 'porcentagem', 'pedido_gratis'];
function configFidelidade(raw) {
  if (!raw || raw.ativo !== true) return null;
  const meta = Math.floor(Number(raw.meta));
  if (!(meta >= 2 && meta <= 30) || !TIPOS_FIDELIDADE.includes(raw.tipo)) return null;
  const valor = Number(raw.valor) || 0, vMax = Number(raw.valorMaximo) || 0;
  if (raw.tipo === 'fixo' && !(valor > 0)) return null;
  if (raw.tipo === 'porcentagem' && !(valor > 0 && valor <= 100)) return null;
  if (raw.tipo === 'pedido_gratis' && !(vMax > 0)) return null;
  return { meta, minimoPedido: Number(raw.minimoPedido) || 0, inicioEm: String(raw.inicioEm || '') };
}
function contaParaMeta(p, cfg, comoEntregue = false) {
  if (!p || !cfg) return false;
  if (!comoEntregue && !entregueSt(p.status)) return false;
  if (p.premioFidelidade) return false;
  if (p.reembolso && p.reembolso.status === 'aprovado' && !p.reembolso.parcial) return false;
  if (cfg.minimoPedido > 0 && (Number(p.subtotal) || 0) < cfg.minimoPedido) return false;
  if (cfg.inicioEm && String(p.criadoEm || '') < cfg.inicioEm) return false;
  return true;
}
/** Este pedido, recém-entregue, fez o cliente completar a meta (ganhou um presente novo)? `pedidosCliente`: objeto {key: pedido} do cliente. */
function ganhouPresente({ pedidoKey, pedido, pedidosCliente, cfgRaw }) {
  const cfg = configFidelidade(cfgRaw);
  if (!cfg || !pedido || !pedido.clienteUid) return false;
  if (!contaParaMeta(pedido, cfg, true)) return false;
  let concluidos = 1;
  for (const [k, p] of Object.entries(pedidosCliente || {})) {
    if (k === pedidoKey || !p || p.clienteUid !== pedido.clienteUid || p.lojaId !== pedido.lojaId) continue;
    if (contaParaMeta(p, cfg)) concluidos++;
  }
  return concluidos % cfg.meta === 0;
}
function avisoPresente({ loja = {} } = {}) {
  const nome = limparTexto(loja.nombre || loja.nome || 'a loja', 60);
  return { titulo: 'Você ganhou um presente! 🎁', corpo: `${nome} preparou uma surpresa para você. Abra o app para descobrir.`, caminho: 'pedidos.html' };
}

// ---------- V7.3: cadastro de lojista (análise do Master) ----------
/** Chave do evento: cada reenvio do cadastro (enviadoEm) e cada decisão (analisadoEm) avisa uma única vez. */
function chaveCadastro(evento, cad) {
  const base = evento === 'novo' ? cad?.enviadoEm : cad?.analisadoEm;
  const t = String(base || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 30);
  return t ? `${evento}_${t}` : null;
}

/** Aviso (push) do cadastro. evento 'novo' → para o Master; 'analisado' → para o lojista. */
function avisoCadastro(evento, cad = {}) {
  if (evento === 'novo') {
    const loja = limparTexto(cad.nomeLoja, 60) || 'Nova loja';
    return { titulo: 'Novo cadastro de lojista', corpo: `${loja} — ${limparTexto(cad.nomeCompleto, 60)} aguarda a sua análise.`, caminho: 'master.html#cadastros' };
  }
  if (cad.status === 'aprovado') return { titulo: 'Cadastro aprovado! 🎉', corpo: 'Você já pode criar a sua loja no YaPOOD. Toque para começar.', caminho: 'admin-loja.html' };
  return { titulo: 'Cadastro não aprovado', corpo: `Motivo: ${limparTexto(cad.motivoRecusa, 160) || 'veja no aplicativo'}. Corrija os dados e envie de novo.`, caminho: 'admin-loja.html' };
}

/** E-mail da decisão (texto simples). */
function emailCadastro(cad = {}, appUrl = '') {
  const primeiro = limparTexto(cad.nomeCompleto, 60).split(' ')[0] || 'tudo bem';
  const link = appUrl ? urlDoApp(appUrl, 'admin-loja.html') : '';
  if (cad.status === 'aprovado') {
    return { assunto: 'Seu cadastro no YaPOOD foi aprovado', texto: `Olá, ${primeiro}!\n\nSeu cadastro de lojista no YaPOOD foi aprovado. Agora você já pode entrar e criar a sua loja${link ? `:\n${link}` : '.'}\n\nEquipe YaPOOD` };
  }
  return { assunto: 'Seu cadastro no YaPOOD não foi aprovado', texto: `Olá, ${primeiro}!\n\nAnalisamos o seu cadastro de lojista e, por enquanto, não foi possível aprová-lo.\nMotivo: ${limparTexto(cad.motivoRecusa, 300) || 'veja no aplicativo'}\n\nVocê pode corrigir os dados e enviar de novo${link ? `:\n${link}` : '.'}\n\nEquipe YaPOOD` };
}

/** Quantos aparelhos ainda cabem no teto de hoje. */
const restanteDoDia = (limite, jaEnviados) => Math.max(0, limite - (Number(jaEnviados) || 0));

// ---------------- V7.3.5: ícones por data (campanhas) e silhueta da barra por app ----------------
const APPS_ICONE = ['cliente', 'painel', 'entregador', 'master'];
const ICONE_PADRAO = { cliente: 'icons/icons-192.png', painel: 'icons/adm-192.png', entregador: 'icons/entregador-192.png', master: 'icons/master-192.png' };
// Ícone pequeno da barra de status: só silhueta de uma cor. O entregador usa a moto, o Master a coroa, os demais os olhos e o sorriso.
const BADGE_DO_APP = { cliente: 'icons/badge-96.png', painel: 'icons/badge-96.png', entregador: 'icons/badge-entregador-96.png', master: 'icons/badge-master-96.png' };
const HOST_ICONE = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_.\-\/%~]+$/;

/** Qual app recebe o aviso, pelo caminho que ele abre. */
function appDoCaminho(caminho) {
  const c = String(caminho || '').replace(/^\/+/, '');
  if (/^admin-loja\.html(?:[?#]|$)/.test(c)) return 'painel';
  if (/^entregador\.html(?:[?#]|$)/.test(c)) return 'entregador';
  if (/^master\.html(?:[?#]|$)/.test(c)) return 'master';
  return 'cliente';
}
/** Data (AAAA-MM-DD) no horário de Brasília. */
const hojeBrasilia = (agoraMs = Date.now()) => new Date(agoraMs - 3 * 3600000).toISOString().slice(0, 10);
const dataIsoValida = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

/** URL do ícone da campanha em vigor para o app (ou ''). Só aceita imagem do Cloudinary em https e datas válidas (de/até inclusivos). */
function iconeDeCampanha(config, app, agoraMs = Date.now()) {
  const c = config && typeof config === 'object' ? config[app] : null;
  if (!c || typeof c !== 'object') return '';
  const url = String(c.url || '');
  if (!HOST_ICONE.test(url) || url.length > 300) return '';
  if (!dataIsoValida(c.de) || !dataIsoValida(c.ate) || c.de > c.ate) return '';
  const hoje = hojeBrasilia(agoraMs);
  return hoje >= c.de && hoje <= c.ate ? url : '';
}

module.exports = { APPS_ICONE, ICONE_PADRAO, BADGE_DO_APP, appDoCaminho, hojeBrasilia, iconeDeCampanha, ALIAS_EVENTO, EVENTOS_PEDIDO, normalizarEvento, ehEventoDePedido, resolverDestino, chaveEvento, montarAviso, urlDoApp, tokenValido, plataformaValida, tokensExcedentes, decidirReserva, criarLimitador, limparTexto, diaBrasilia, configCupom, cupomElegivel, montarAvisoCupom, publicoDaLoja, configFidelidade, ganhouPresente, avisoPresente, restanteDoDia, chaveCadastro, avisoCadastro, emailCadastro, LIMITE_DIARIO_PADRAO, MAX_PEDIDOS_PUBLICO };
