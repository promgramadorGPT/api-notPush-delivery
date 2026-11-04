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

// ---------- V7.4: notificação do pedido por etapa (uma só por pedido, trocada a cada etapa) ----------
// Etapas da barra: 1 Recebido · 2 Preparando · 3 A caminho · 4 Chegando · 5 Entregue. "Recebido" não manda push.
const ETAPA_DO_EVENTO = { aceptado: 2, despachado: 3, chegando: 4, entregue: 5 };
const IMAGEM_DA_ETAPA = { 2: 'icons/status/2-preparando.png', 3: 'icons/status/3-a-caminho.png', 4: 'icons/status/4-chegando.png', 5: 'icons/status/5-entregue.png' };
const CHEGANDO_M = 150;
const ehAvisoDeEtapa = (evento) => Object.prototype.hasOwnProperty.call(ETAPA_DO_EVENTO, evento);
/** Mesma tag para todos os avisos de etapa do pedido: o novo substitui o anterior na bandeja. */
const tagDoPedido = (pedidoKey) => `pedido-${pedidoKey}`;

/** "30-40" → "30–40 min"; "45" → "45 min"; texto livre curto fica como está. */
function textoTempo(v) {
  const t = limparTexto(v, 30);
  if (!t) return '';
  const m = /^(\d{1,3})\s*(?:-|–|a|até)\s*(\d{1,3})(?:\s*min\w*)?$/i.exec(t);
  if (m) return `${m[1]}–${m[2]} min`;
  if (/^\d{1,3}(?:\s*min\w*)?$/i.test(t)) return `${parseInt(t, 10)} min`;
  return t;
}

/** Quem leva (para o texto): { nome, tipo: 'loja' | 'parceiro' } ou null. Só o primeiro nome. */
function quemLevaDe({ rastreio, entregador } = {}) {
  const nome = limparTexto((rastreio && rastreio.entregador && rastreio.entregador.nome) || (entregador && entregador.nome) || '', 40).split(' ')[0];
  if (!nome) return null;
  return { nome, tipo: rastreio && rastreio.parceiro ? 'parceiro' : 'loja' };
}

/** O aviso "chegando" vale agora? Pedido de delivery ainda não entregue/cancelado e rastreio recente com distância ≤ 150 m. */
function chegandoValido({ pedido, rastreio, agora = Date.now() } = {}) {
  if (!pedido || !pedido.clienteUid) return { ok: false, motivo: 'pedido' };
  if (pedido.tipoEntrega && pedido.tipoEntrega !== 'delivery') return { ok: false, motivo: 'retirada' };
  if (/entreg|cancel|rechaz|recus/i.test(String(pedido.status || ''))) return { ok: false, motivo: 'encerrado' };
  const d = rastreio && typeof rastreio.distanciaM === 'number' ? rastreio.distanciaM : null;
  if (d === null || !(d >= 0) || d > CHEGANDO_M) return { ok: false, motivo: 'longe' };
  const em = Number(rastreio.atualizadoEm);
  if (!Number.isFinite(em) || agora - em > 3 * 60000) return { ok: false, motivo: 'rastreio-antigo' };
  return { ok: true };
}

/** Título, corpo e caminho (relativo ao app) de cada aviso. Avisos de etapa trazem também etapa, imagem e botões. */
function montarAviso(evento, { pedido = {}, nomeBairro = '', loja = {}, quemLeva = null } = {}) {
  const num = pedido.numeroPedido ? ` #${limparTexto(pedido.numeroPedido, 20)}` : '';
  const q = pedido.numeroPedido ? `status.html?num=${encodeURIComponent(pedido.numeroPedido)}` : 'pedidos.html';
  const etapa = ETAPA_DO_EVENTO[evento];
  const comEtapa = (aviso, acoes) => ({ ...aviso, etapa, imagem: IMAGEM_DA_ETAPA[etapa], acoes });
  const nomeLoja = limparTexto(loja.nombre || loja.nome || '', 40);
  const quem = quemLeva && quemLeva.nome ? `${quemLeva.nome} (${quemLeva.tipo === 'parceiro' ? 'parceiro YaPOOD' : 'entregador da loja'})` : '';
  switch (evento) {
    case 'novo': return { titulo: 'Novo pedido', corpo: `Você recebeu um novo pedido${num}.`, caminho: 'admin-loja.html', icone: 'icons/adm-192.png' };
    case 'aceptado': {
      const tempo = textoTempo(loja.tiempoEntrega || loja.tempoEntrega);
      const partes = [nomeLoja, tempo ? `chega em ${tempo}` : '', num.trim()].filter(Boolean);
      return comEtapa({ titulo: '🍳 Pedido sendo preparado', corpo: partes.join(' · ') || 'A loja aceitou e já está preparando o seu pedido.', caminho: q }, [{ acao: 'ver', titulo: 'Ver pedido' }]);
    }
    case 'despachado':
      return comEtapa({ titulo: '🛵 Saiu para entrega', corpo: `${quem ? `${quem} está a caminho` : 'Seu pedido está a caminho'}${num ? ` ·${num}` : ''}`, caminho: q }, [{ acao: 'mapa', titulo: 'Ver no mapa' }]);
    case 'chegando':
      return comEtapa({ titulo: '📍 O entregador está chegando!', corpo: `${quemLeva && quemLeva.nome ? quemLeva.nome : 'O entregador'} está a menos de ${CHEGANDO_M} m. Prepare-se para receber.`, caminho: q }, [{ acao: 'mapa', titulo: 'Ver no mapa' }]);
    case 'entregue': return comEtapa({ titulo: '✅ Pedido entregue', corpo: 'Bom apetite! Toque para avaliar o pedido.', caminho: q }, [{ acao: 'avaliar', titulo: 'Avaliar' }]);
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

// ---------- V7.5 — aviso de mensagem na conversa do pedido (cliente ↔ loja) ----------
const CHAT_INTERVALO_MS = 2 * 60000;   // no máximo 1 aviso a cada 2 min por conversa e por destino
const CHAT_MSG_RECENTE_MS = 10 * 60000; // só avisa mensagem recente (evita reenviar coisa antiga)
const CHAT_PREVIA = 90;
// Mesmas regras do site (js/chat-util.js): telefones, e-mails, @perfis e links saem escondidos também no aviso.
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const RE_LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|br|net|org|me|ly|io|app|link|site|online|store|shop|gl|to|bio)\b(?:\/\S*)?/gi;
const RE_PERFIL = /(^|[\s(])@[\w.]{3,}/g;
const RE_TEL = /(?:\+?\d[\s().\-]*){7,}\d/g;
function esconderContato(texto) {
  return String(texto == null ? '' : texto)
    .replace(RE_EMAIL, '[contato escondido]')
    .replace(RE_LINK, '[link escondido]')
    .replace(RE_PERFIL, (_m, a) => `${a}[contato escondido]`)
    .replace(RE_TEL, (m) => (m.replace(/\D/g, '').length >= 8 ? '[número escondido]' : m));
}
/** Prévia do texto para o aviso: sem contato, numa linha, até 90 caracteres. */
function previaChat(texto) {
  const t = esconderContato(texto).replace(/\s+/g, ' ').trim();
  return t.length > CHAT_PREVIA ? t.slice(0, CHAT_PREVIA - 1).trimEnd() + '…' : t;
}
/** Quem está escrevendo e para quem vai o aviso. { lado, destinoUid, destinoLado } ou { erro, status }. */
function destinoChat({ uid, pedido, loja }) {
  if (!pedido || !loja) return { erro: 'Pedido não encontrado.', status: 404 };
  if (uid && uid === pedido.clienteUid) return loja.ownerUid ? { lado: 'cliente', destinoLado: 'loja', destinoUid: loja.ownerUid } : { erro: 'Loja sem dono.', status: 404 };
  if (uid && uid === loja.ownerUid) return pedido.clienteUid ? { lado: 'loja', destinoLado: 'cliente', destinoUid: pedido.clienteUid } : { erro: 'Pedido sem cliente.', status: 404 };
  return { erro: 'Você não participa desta conversa.', status: 403 };
}
/** Confere a mensagem e decide se avisa. { ok, novas } ou { ok:false, motivo, status }. */
function decidirAvisoChat({ chat, mensagemId, uid, lado, destinoLado, ultimoAviso, agora = Date.now() }) {
  const m = chat && chat.msgs && chat.msgs[mensagemId];
  if (!m || m.uid !== uid || m.de !== lado || typeof m.texto !== 'string') return { ok: false, motivo: 'mensagem', status: 404 };
  const em = Number(m.em) || 0;
  if (!em || agora - em > CHAT_MSG_RECENTE_MS) return { ok: false, motivo: 'antiga', status: 409 };
  const lido = Number(chat.lido && chat.lido[destinoLado]) || 0;
  if (lido >= em) return { ok: false, motivo: 'lida', status: 200 };
  if (ultimoAviso && agora - Number(ultimoAviso) < CHAT_INTERVALO_MS) return { ok: false, motivo: 'intervalo', status: 200 };
  const novas = Object.values(chat.msgs || {}).filter((x) => x && x.de === lado && (Number(x.em) || 0) > lido).length || 1;
  return { ok: true, novas, texto: m.texto };
}
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || 'Cliente';
/** Texto do aviso. Cliente: abre o pedido com a conversa; loja: abre o painel na conversa. */
function avisoChat({ destinoLado, pedidoKey, pedido = {}, loja = {}, texto = '', novas = 1 }) {
  const num = pedido.numeroPedido || pedidoKey;
  const previa = previaChat(texto);
  const mais = novas > 1 ? `${novas} mensagens novas · ` : '';
  if (destinoLado === 'cliente') {
    return { titulo: `💬 ${loja.nombre || loja.nome || 'A loja'} te mandou uma mensagem`, corpo: `Pedido #${num}: ${mais}${previa}`,
      caminho: `status.html?num=${encodeURIComponent(num)}&chat=1`, renotify: true };
  }
  const nome = primeiroNome(pedido.cliente && (pedido.cliente.nombre || pedido.cliente.nome));
  return { titulo: `💬 Mensagem do cliente · Pedido #${num}`, corpo: `${nome}: ${mais}${previa}`,
    caminho: `admin-loja.html?chat=${encodeURIComponent(pedidoKey)}`, renotify: true };
}
const tagDoChat = (pedidoKey) => `chat-${pedidoKey}`;

// ---------- V7.6 — ofertas automáticas (agendador do Master) ----------
// config_plataforma/push_auto = { ativo, horarios: { cafe|almoco|jantar: { ativo, hora: 'HH:MM', dias: '0123456', modo: 'oferta'|'fixa', titulo, corpo, lojaId } } }
// O agendador (cron-job.org) chama POST /cron/ofertas a cada 15 min; cada horário sai no máximo 1 vez por dia, nos 30 min depois da hora.
const HORARIOS_AUTO = ['cafe', 'almoco', 'jantar'];
const HORARIO_PADRAO = { cafe: { hora: '08:00', emoji: '☕', nome: 'café' }, almoco: { hora: '11:00', emoji: '🍽️', nome: 'almoço' }, jantar: { hora: '18:30', emoji: '🌙', nome: 'jantar' } };
const JANELA_AUTO_MIN = 30;
const DIAS_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const minutosHHMM = (h) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(h || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minutosLivres = (h) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(h || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Relógio de Brasília (sem horário de verão desde 2019): dia AAAA-MM-DD, dia da semana (0 = domingo) e minutos do dia. */
function relogioBrasilia(agora = Date.now()) {
  const d = new Date(agora - 3 * 3600000);
  return { dia: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Configuração do Master normalizada. Sem configuração: tudo desligado. */
function configAuto(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const horarios = {};
  for (const id of HORARIOS_AUTO) {
    const s = (r.horarios && typeof r.horarios === 'object' && r.horarios[id]) || {};
    const dias = /^[0-6]{0,7}$/.test(String(s.dias ?? '0123456')) ? [...new Set(String(s.dias ?? '0123456').split('').map(Number))].sort() : [0, 1, 2, 3, 4, 5, 6];
    horarios[id] = {
      ativo: s.ativo === true,
      hora: minutosHHMM(s.hora) !== null ? s.hora : HORARIO_PADRAO[id].hora,
      dias,
      modo: s.modo === 'fixa' ? 'fixa' : 'oferta',
      titulo: limparTexto(s.titulo, 80),
      corpo: limparTexto(s.corpo, 200),
      lojaId: typeof s.lojaId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.lojaId) ? s.lojaId : ''
    };
  }
  return { ativo: r.ativo === true, horarios };
}

/** Quais horários devem sair agora: chave geral e o horário ligados, dia da semana marcado e de 0 a 29 min depois da hora. */
function horariosDaVez(cfg, agora = Date.now(), janela = JANELA_AUTO_MIN) {
  if (!cfg || !cfg.ativo) return [];
  const { dow, min } = relogioBrasilia(agora);
  return HORARIOS_AUTO.filter((id) => {
    const s = cfg.horarios[id];
    if (!s || !s.ativo || !s.dias.includes(dow)) return false;
    if (s.modo === 'fixa' && (!s.titulo || !s.corpo)) return false;
    const h = minutosHHMM(s.hora);
    return h !== null && min >= h && min < h + janela;
  });
}

/** A loja está aberta agora (horário de Brasília)? Mesma regra do app (js/regras.js lojaAberta + js/abertura-loja.js). */
function lojaAbertaAgora(loja, agora = Date.now()) {
  if (!loja || loja.activo === false) return false;
  const ab = loja.abertura || {};
  const abreAs = Number(ab.abreAs);
  if ((ab.resposta === 'adiado' || ab.resposta === 'hoje-nao') && Number.isFinite(abreAs) && abreAs > agora) return false;
  const horarios = loja.horarios;
  if (!horarios || typeof horarios !== 'object') return true;
  const { dow, min: t } = relogioBrasilia(agora);
  const hoje = horarios[DIAS_SEMANA[dow]], ontem = horarios[DIAS_SEMANA[(dow + 6) % 7]];
  if (ontem && ontem.aberto !== false) {
    const a = minutosLivres(ontem.abre), f = minutosLivres(ontem.fecha);
    if (a !== null && f !== null && f <= a && t < f) return true;
  }
  if (!hoje) return true;
  if (hoje.aberto === false) return false;
  const a = minutosLivres(hoje.abre), f = minutosLivres(hoje.fecha);
  if (a === null || f === null) return true;
  return f > a ? (t >= a && t < f) : (t >= a || t < f);
}

/** Loja de cidade que ainda não abriu (em espera) não é divulgada. Loja sem cidade, ou cidade não cadastrada: pode. */
function cidadeLiberada(loja, cidades) {
  const id = loja && loja.cidadeId;
  if (!id) return true;
  const c = cidades && cidades[id];
  return !c || c.status === 'aberta';
}

/** A loja pode aparecer numa notificação agora? Ativa, não suspensa, cidade aberta e aberta neste horário. */
const lojaDivulgavel = (lojaId, loja, { suspensas = {}, cidades = {}, agora = Date.now() } = {}) =>
  !!loja && loja.activo !== false && !(suspensas && suspensas[lojaId] != null) && cidadeLiberada(loja, cidades) && lojaAbertaAgora(loja, agora);

/** Cupons públicos válidos hoje (não secretos, não esgotados), o melhor primeiro; cupom de 1ª compra fica por último. */
function cuponsDivulgaveis(loja, usoLoja = {}, agora = Date.now()) {
  const lista = Object.entries((loja && loja.cupones) || {})
    .filter(([, c]) => c && c.oculto !== true && cupomElegivel(c, agora))
    .filter(([, c]) => { const max = Number.isInteger(c.maxUsos) && c.maxUsos > 0 ? c.maxUsos : 0; const u = usoLoja && usoLoja[c.codigo]; return !max || (Number(u && u.total) || 0) < max; });
  const peso = (c) => (c.primeiraCompra === true ? -10000 : 0) + (c.tipo === 'porcentagem' ? 3000 + Number(c.valor) : c.tipo === 'fixo' ? 1000 + Number(c.valor) : 2000) - (Number(c.minimo) || 0) / 1000;
  return lista.sort(([, a], [, b]) => peso(b) - peso(a)).map(([id, c]) => ({ cupomId: id, cupom: c }));
}

/** Oferta automática: entre as lojas divulgáveis com cupom, a que apareceu há mais tempo (revezamento). */
function escolherOferta({ lojas = {}, suspensas = {}, cidades = {}, historico = {}, usoCupons = {}, agora = Date.now() } = {}) {
  const cand = [];
  for (const [lojaId, loja] of Object.entries(lojas || {})) {
    if (!lojaDivulgavel(lojaId, loja, { suspensas, cidades, agora })) continue;
    const cupons = cuponsDivulgaveis(loja, (usoCupons || {})[lojaId], agora);
    if (!cupons.length) continue;
    cand.push({ lojaId, loja, ...cupons[0], ultimo: Number(historico && historico[lojaId] && historico[lojaId].ultimoEm) || 0 });
  }
  cand.sort((a, b) => a.ultimo - b.ultimo || String(a.loja.nombre || '').localeCompare(String(b.loja.nombre || ''), 'pt-BR') || a.lojaId.localeCompare(b.lojaId));
  return cand[0] || null;
}

/** Anúncio só sai no almoço e no jantar (o café fica para as ofertas automáticas). */
const HORARIOS_ANUNCIO = ['almoco', 'jantar'];
/** Notificações de cada plano de anúncio (Master: config_plataforma/anuncios_planos n7/n15/n30, de 0 a 10). */
function pushDosPlanos(cfg) {
  const out = {};
  for (const d of [7, 15, 30]) { const n = Math.floor(Number(cfg && cfg[`n${d}`])); out[d] = n >= 0 && n <= 10 ? n : 0; }
  return out;
}

/** Anúncio que tem notificação para gastar: no ar, dentro do prazo, loja divulgável; o que acaba primeiro vai antes. */
function escolherAnuncio({ anuncios = {}, pushUso = {}, planos = {}, lojas = {}, suspensas = {}, cidades = {}, agora = Date.now() } = {}) {
  const porPlano = pushDosPlanos(planos);
  const cand = [];
  for (const [id, a] of Object.entries(anuncios || {})) {
    if (!a || a.status !== 'no_ar' || !(Number(a.fimEm) > agora) || typeof a.lojaId !== 'string') continue;
    const uso = (pushUso || {})[id] || {};
    const total = Number.isInteger(uso.total) ? uso.total : (porPlano[Number(a.dias)] || 0);
    const usados = Number(uso.usados) || 0;
    if (usados >= total) continue;
    const loja = lojas[a.lojaId];
    if (!lojaDivulgavel(a.lojaId, loja, { suspensas, cidades, agora })) continue;
    cand.push({ anuncioId: id, anuncio: a, lojaId: a.lojaId, loja, total, usados });
  }
  cand.sort((x, y) => Number(x.anuncio.fimEm) - Number(y.anuncio.fimEm) || x.anuncioId.localeCompare(y.anuncioId));
  return cand[0] || null;
}

const reaisCurto = (v) => { const n = Number(v || 0); return Number.isInteger(n) ? `R$ ${n}` : reais(n); };
/** Texto do valor do cupom: "10% OFF (até R$ 15,00)", "R$ 5,00 OFF" ou "Entrega grátis". */
function valorDoCupom(c = {}) {
  if (c.tipo === 'porcentagem') return `${Number(c.valor)}% OFF${Number(c.teto) > 0 ? ` (até ${reaisCurto(c.teto)})` : ''}`;
  if (c.tipo === 'fixo') return `${reaisCurto(c.valor)} OFF`;
  return 'Entrega grátis';
}

/** Aviso da oferta: "🍽️ Oferta da Uai Crep's" / "10% OFF em pedidos acima de R$ 30. Toque para pedir no almoço." Abre a loja com o cupom. */
function avisoOferta({ lojaId, loja = {}, cupom = null, horario = 'almoco', frase = '' }) {
  const h = HORARIO_PADRAO[horario] || HORARIO_PADRAO.almoco;
  const nome = limparTexto(loja.nombre || loja.nome || 'sua loja favorita', 40);
  let corpo;
  if (limparTexto(frase, 160)) corpo = limparTexto(frase, 160);
  else if (cupom) {
    const min = Number(cupom.minimo) > 0 ? ` em pedidos acima de ${reaisCurto(cupom.minimo)}` : '';
    const primeira = cupom.primeiraCompra === true ? ' na sua 1ª compra na loja' : '';
    const sel = cupom.produtos && Object.values(cupom.produtos).some((v) => v === true) ? ' em produtos selecionados' : '';
    corpo = `${valorDoCupom(cupom)}${sel}${min}${primeira}. Toque para pedir no ${h.nome}.`;
  } else corpo = `Toque para ver o cardápio e pedir no ${h.nome}.`;
  const cod = cupom && /^[A-Z0-9_-]{3,20}$/.test(String(cupom.codigo || '')) ? `&cupom=${encodeURIComponent(cupom.codigo)}` : '';
  return { titulo: limparTexto(`${h.emoji} Oferta da ${nome}`, 100), corpo: limparTexto(corpo, 200), caminho: `restaurante.html?id=${encodeURIComponent(lojaId)}${cod}` };
}

/** Quem recebe ofertas: aparelhos de todos, menos quem desligou "Ofertas e cupons" (prefs_ofertas/{uid} = false) e as contas bloqueadas. */
function publicoOfertas(fcmTokens = {}, optOut = {}, bloqueados = {}) {
  const vistos = new Set(), lista = [];
  for (const [uid, entries] of Object.entries(fcmTokens || {})) {
    if ((optOut && optOut[uid] === false) || (bloqueados && bloqueados[uid] != null)) continue;
    for (const [tokenId, item] of Object.entries(entries || {})) {
      if (item && item.token && !vistos.has(item.token)) { vistos.add(item.token); lista.push({ uid, tokenId, token: item.token }); }
    }
  }
  return lista;
}
const aceitaOfertas = (optOut, uid) => !(optOut && optOut[uid] === false);

module.exports = { HORARIOS_AUTO, HORARIOS_ANUNCIO, reaisCurto, HORARIO_PADRAO, JANELA_AUTO_MIN, relogioBrasilia, configAuto, horariosDaVez, lojaAbertaAgora, cidadeLiberada, lojaDivulgavel, cuponsDivulgaveis, escolherOferta, pushDosPlanos, escolherAnuncio, valorDoCupom, avisoOferta, publicoOfertas, aceitaOfertas, CHAT_INTERVALO_MS, CHAT_MSG_RECENTE_MS, esconderContato, previaChat, destinoChat, decidirAvisoChat, avisoChat, tagDoChat, ETAPA_DO_EVENTO, IMAGEM_DA_ETAPA, CHEGANDO_M, ehAvisoDeEtapa, tagDoPedido, textoTempo, quemLevaDe, chegandoValido, APPS_ICONE, ICONE_PADRAO, BADGE_DO_APP, appDoCaminho, hojeBrasilia, iconeDeCampanha, ALIAS_EVENTO, EVENTOS_PEDIDO, normalizarEvento, ehEventoDePedido, resolverDestino, chaveEvento, montarAviso, urlDoApp, tokenValido, plataformaValida, tokensExcedentes, decidirReserva, criarLimitador, limparTexto, diaBrasilia, configCupom, cupomElegivel, montarAvisoCupom, publicoDaLoja, configFidelidade, ganhouPresente, avisoPresente, restanteDoDia, chaveCadastro, avisoCadastro, emailCadastro, LIMITE_DIARIO_PADRAO, MAX_PEDIDOS_PUBLICO };
