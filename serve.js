// NotPush Delivery V7 — BR. Rotas e autenticação (Firebase ID Token) mantidas da V6; regras puras em notificacoes.js.
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const admin = require("firebase-admin");
const crypto = require("crypto");
const N = require("./notificacoes");

const VERSAO = "7.3.1";
const MAX_TOKENS_POR_USUARIO = 10;
const app = express();

const ORIGENS_PERMITIDAS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: ORIGENS_PERMITIDAS.length
    ? (origin, cb) => (!origin || ORIGENS_PERMITIDAS.includes(origin)) ? cb(null, true) : cb(new Error("Origem não permitida."))
    : true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(helmet());
app.use(express.json({ limit: "20kb" }));

function log(...args) { console.log("[NotPush]", ...args); }

let firebaseReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não configurado.");
  const serviceAccount = JSON.parse(raw);
  if (process.env.EXPECTED_PROJECT_ID && serviceAccount.project_id !== process.env.EXPECTED_PROJECT_ID) {
    throw new Error(`Projeto Firebase inesperado: ${serviceAccount.project_id} (esperado ${process.env.EXPECTED_PROJECT_ID}).`);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: process.env.FIREBASE_DATABASE_URL });
  firebaseReady = true;
  log("Firebase Admin conectado ao projeto:", serviceAccount.project_id);
  if (!ORIGENS_PERMITIDAS.length) log("AVISO: ALLOWED_ORIGINS não configurado; qualquer origem é aceita.");
  if (!/^https:\/\//.test(process.env.APP_URL || "")) log("AVISO: APP_URL não é https; os avisos saem sem link de abertura.");
} catch (err) {
  console.error("[NotPush] Erro ao inicializar Firebase:", err.message);
}

const db = () => admin.database();
const limite = N.criarLimitador(40, 60000); // por usuário, por minuto

async function autenticar(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "Token Firebase ausente." });
    req.user = await admin.auth().verifyIdToken(header.slice(7));
    next();
  } catch (err) {
    console.error("[NotPush] Falha auth:", err.message);
    return res.status(401).json({ ok: false, error: "Token Firebase inválido." });
  }
}

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const comTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms.`)), ms))]);
const erroInterno = (res, rota, err) => { console.error(`[NotPush] ERRO ${rota}:`, err); return res.status(500).json({ ok: false, error: "Erro interno. Tente novamente." }); };
const idSeguro = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const lerValor = async (caminho) => (await db().ref(caminho).once("value")).val();

app.get("/", (req, res) => res.json({ ok: true, service: "notpush-delivery", versao: VERSAO }));
app.get("/health", (req, res) => res.json({ ok: true, service: "notpush-delivery", versao: VERSAO, firebase: firebaseReady, time: new Date().toISOString() }));

// ---------------- Tokens de aparelho ----------------
app.post("/registrar-token", autenticar, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!N.tokenValido(token)) return res.status(400).json({ ok: false, error: "Token FCM ausente ou inválido." });
    const uid = req.user.uid;
    if (!limite("tok:" + uid)) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um minuto." });
    const tokenId = hashToken(token);

    // O mesmo aparelho só pode pertencer a uma conta: se outra conta usou antes, tira dela
    // (senão os próximos avisos do outro usuário apareceriam neste aparelho).
    const dono = await lerValor(`fcm_token_owner/${tokenId}`);
    if (dono?.uid && dono.uid !== uid) await db().ref(`fcm_tokens/${dono.uid}/${tokenId}`).remove();

    const agora = new Date().toISOString();
    await db().ref(`fcm_tokens/${uid}/${tokenId}`).set({ token, plataforma: N.plataformaValida(req.body.plataforma), uid, atualizadoEm: agora });
    await db().ref(`fcm_token_owner/${tokenId}`).set({ uid, atualizadoEm: agora });

    const todos = await lerValor(`fcm_tokens/${uid}`);
    for (const id of N.tokensExcedentes(todos, MAX_TOKENS_POR_USUARIO)) {
      await db().ref(`fcm_tokens/${uid}/${id}`).remove();
      const o = await lerValor(`fcm_token_owner/${id}`);
      if (o?.uid === uid) await db().ref(`fcm_token_owner/${id}`).remove();
    }
    log("Token registrado:", uid, tokenId);
    return res.json({ ok: true, uid, tokenId });
  } catch (err) { return erroInterno(res, "/registrar-token", err); }
});

app.post("/remover-token", autenticar, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!N.tokenValido(token)) return res.status(400).json({ ok: false, error: "Token FCM ausente ou inválido." });
    const uid = req.user.uid;
    const tokenId = hashToken(token);
    await db().ref(`fcm_tokens/${uid}/${tokenId}`).remove();
    const dono = await lerValor(`fcm_token_owner/${tokenId}`);
    if (dono?.uid === uid) await db().ref(`fcm_token_owner/${tokenId}`).remove();
    log("Token removido:", uid, tokenId);
    return res.json({ ok: true });
  } catch (err) { return erroInterno(res, "/remover-token", err); }
});

// ---------------- Envio ----------------
function montarMensagem(token, aviso, dados) {
  const url = N.urlDoApp(process.env.APP_URL || "", aviso.caminho);
  const https = url.startsWith("https://");
  const icone = https ? N.urlDoApp(process.env.APP_URL, aviso.icone || "icons/icons-192.png") : undefined;
  const tag = dados.tag;
  return {
    token,
    notification: { title: aviso.titulo, body: aviso.corpo },
    data: { ...Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, String(v)])), url, link: url },
    webpush: {
      headers: { Urgency: "high", TTL: "3600" },
      notification: { ...(icone ? { icon: icone, badge: icone } : {}), tag }, // mesma tag evita aviso em dobro (SDK + service worker)
      ...(https ? { fcmOptions: { link: url } } : {})
    }
  };
}

/** Envia aos aparelhos do destino, limpa tokens mortos e devolve o resultado. */
async function enviarParaUsuario(destinoUid, aviso, dados) {
  const tokensObj = (await lerValor(`fcm_tokens/${destinoUid}`)) || {};
  const itens = Object.entries(tokensObj).filter(([, v]) => v?.token).map(([id, v]) => ({ id, token: v.token }));
  if (!itens.length) return { enviados: 0, falhas: 0, tokens: 0, semToken: true };
  const enviados = [], falhas = [], invalidos = [];
  const respostas = await Promise.allSettled(itens.map(it => comTimeout(admin.messaging().send(montarMensagem(it.token, aviso, dados)), 20000, "Envio FCM")));
  respostas.forEach((r, i) => {
    if (r.status === "fulfilled") { enviados.push(r.value); return; }
    const code = r.reason?.code || "unknown";
    falhas.push({ index: i, code, message: r.reason?.message || String(r.reason) });
    console.error(`[NotPush] FCM ERRO ${i + 1}/${itens.length}:`, code, r.reason?.message);
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) invalidos.push(itens[i]);
  });
  for (const it of invalidos) {
    await db().ref(`fcm_tokens/${destinoUid}/${it.id}`).remove().catch(() => {});
    await db().ref(`fcm_token_owner/${it.id}`).remove().catch(() => {});
  }
  return { enviados: enviados.length, falhas: falhas.length, tokens: itens.length, semToken: false, messageIds: enviados, erros: falhas };
}

/** Reserva o evento (transação) para que duas chamadas simultâneas não enviem duas vezes. */
async function reservar(caminho) {
  let motivo = null;
  const agora = Date.now();
  const t = await db().ref(caminho).transaction(atual => {
    const d = N.decidirReserva(atual, agora);
    if (!d.ok) { motivo = d.motivo; return undefined; }
    return { reservadoEm: agora };
  });
  return t.committed ? { ok: true } : { ok: false, motivo: motivo || "duplicado" };
}

async function dispararAviso({ caminhoRegistro, destinoUid, porUid, aviso, dados }) {
  const r = await reservar(caminhoRegistro);
  if (!r.ok) return { duplicado: true, motivo: r.motivo };
  try {
    const resultado = await enviarParaUsuario(destinoUid, aviso, dados);
    await db().ref(caminhoRegistro).set({ criadoEm: new Date().toISOString(), destinoUid, porUid, resultado });
    log("RESULTADO:", caminhoRegistro, JSON.stringify({ ...resultado, messageIds: undefined, erros: undefined }));
    return { resultado };
  } catch (err) {
    await db().ref(caminhoRegistro).remove().catch(() => {}); // libera para nova tentativa
    throw err;
  }
}

// V7.2 — Se esta entrega completou a meta da fidelidade, avisa o cliente (sem revelar o presente). 1 vez por pedido; falha aqui nunca derruba o aviso de entrega.
async function avisarPresente({ pedidoKey, pedido, loja, porUid }) {
  try {
    const cfgRaw = loja.fidelidade;
    if (!cfgRaw || cfgRaw.ativo !== true || !pedido.clienteUid) return null;
    const snap = await db().ref("pedidos").orderByChild("clienteUid").equalTo(pedido.clienteUid).limitToLast(500).once("value");
    if (!N.ganhouPresente({ pedidoKey, pedido, pedidosCliente: snap.val() || {}, cfgRaw })) return null;
    const r = await dispararAviso({
      caminhoRegistro: `notificaciones_pedidos/${pedidoKey}/presente`, destinoUid: pedido.clienteUid, porUid, aviso: N.avisoPresente({ loja }),
      dados: { tipo: "presente", evento: "presente", pedidoKey, lojaId: pedido.lojaId, tag: `${pedidoKey}:presente` }
    });
    return r.duplicado ? { duplicado: true } : { enviados: r.resultado.enviados, falhas: r.resultado.falhas };
  } catch (err) { console.error("[NotPush] presente:", err.message); return { erro: true }; }
}

app.post("/notificar-pedido", autenticar, async (req, res) => {
  try {
    const { pedidoKey } = req.body || {};
    const evento = N.normalizarEvento(req.body?.evento);
    const uid = req.user.uid;
    if (!limite("ped:" + uid)) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um minuto." });
    if (evento === "bairro") return notificarBairro(req, res);
    if (!idSeguro(pedidoKey)) return res.status(400).json({ ok: false, error: "pedidoKey ausente ou inválido." });
    if (!evento || !N.ehEventoDePedido(evento)) {
      return res.status(400).json({ ok: false, error: "Evento inválido. Use novo, aceito, despachado, entregue, atribuido ou bairro." });
    }
    log("Pedido:", pedidoKey, "evento:", evento, "por:", uid);

    const pedido = await lerValor(`pedidos/${pedidoKey}`);
    if (!pedido) return res.status(404).json({ ok: false, error: "Pedido não encontrado." });
    const loja = await lerValor(`restaurantes/${pedido.lojaId}`);
    if (!loja || !loja.ownerUid) return res.status(404).json({ ok: false, error: "Loja do pedido não encontrada ou sem ownerUid." });

    const entrega = (evento === "entregue" || evento === "atribuido") ? await lerValor(`entregas/${pedidoKey}`) : null;
    const entregador = (evento === "atribuido" && entrega?.entregadorUid) ? await lerValor(`entregadores/${entrega.entregadorUid}`) : null;

    const d = N.resolverDestino(evento, { uid, pedido, loja, entrega, entregador });
    if (d.erro) return res.status(d.status).json({ ok: false, error: d.erro });
    if (!d.destinoUid) return res.status(400).json({ ok: false, error: "Destino da notificação não encontrado." });

    const chave = N.chaveEvento(evento, d.destinoUid);
    const aviso = N.montarAviso(evento, { pedido });
    const r = await dispararAviso({
      caminhoRegistro: `notificaciones_pedidos/${pedidoKey}/${chave}`, destinoUid: d.destinoUid, porUid: uid, aviso,
      dados: { tipo: evento, evento, pedidoKey, tag: `${pedidoKey}:${chave}` }
    });
    if (r.duplicado) return res.json({ ok: true, pedidoKey, evento, destinoUid: d.destinoUid, duplicado: true });
    const presente = evento === "entregue" ? await avisarPresente({ pedidoKey, pedido, loja, porUid: uid }) : undefined;
    return res.json({ ok: r.resultado.falhas === 0, pedidoKey, evento, destinoUid: d.destinoUid, ...r.resultado, ...(presente ? { presente } : {}) });
  } catch (err) { return erroInterno(res, "/notificar-pedido", err); }
});

// Cliente pediu em bairro que a loja ainda não conhece → avisa o dono. Chamada pelo próprio cliente que criou a sugestão.
async function notificarBairro(req, res) {
  try {
    const { lojaId, bairroId } = req.body || {};
    const uid = req.user.uid;
    if (!idSeguro(lojaId) || !/^[a-z0-9]{2,60}$/.test(String(bairroId || ""))) return res.status(400).json({ ok: false, error: "Loja ou bairro inválido." });
    const sug = await lerValor(`bairros_sugeridos/${lojaId}/${bairroId}`);
    if (!sug || sug.clienteUid !== uid || sug.status !== "pendente") return res.status(404).json({ ok: false, error: "Sugestão de bairro não encontrada." });
    const loja = await lerValor(`restaurantes/${lojaId}`);
    if (!loja?.ownerUid) return res.status(404).json({ ok: false, error: "Loja não encontrada." });
    const aviso = N.montarAviso("bairro", { nomeBairro: sug.nome });
    const r = await dispararAviso({
      caminhoRegistro: `notificaciones_bairros/${lojaId}/${bairroId}`, destinoUid: loja.ownerUid, porUid: uid, aviso,
      dados: { tipo: "bairro", evento: "bairro", lojaId, bairroId, tag: `bairro:${lojaId}:${bairroId}` }
    });
    if (r.duplicado) return res.json({ ok: true, lojaId, bairroId, evento: "bairro", duplicado: true });
    return res.json({ ok: r.resultado.falhas === 0, lojaId, bairroId, evento: "bairro", destinoUid: loja.ownerUid, ...r.resultado });
  } catch (err) { return erroInterno(res, "/notificar-pedido (bairro)", err); }
}

// ---------------- Campanha do Master ----------------
app.post("/notificar-master", autenticar, async (req, res) => {
  try {
    const titulo = N.limparTexto(req.body?.titulo, 100);
    const corpo = N.limparTexto(req.body?.corpo, 300);
    if (!titulo) return res.status(400).json({ ok: false, error: "Título ausente." });
    if (!corpo) return res.status(400).json({ ok: false, error: "Mensagem ausente." });
    const link = String(req.body?.link || "").trim();
    if (link && !/^https:\/\/[^\s]+$/.test(link) && !/^\/[^\s]*$/.test(link)) return res.status(400).json({ ok: false, error: "Link inválido (use https:// ou um caminho como /index.html)." });
    const campanha = idSeguro(req.body?.campanhaId) ? req.body.campanhaId : `master-${Date.now()}`;

    if ((await lerValor(`admins/${req.user.uid}/role`)) !== "master") return res.status(403).json({ ok: false, error: "Usuário não é Master." });

    const usersTokens = (await lerValor("fcm_tokens")) || {};
    const vistos = new Set(), tokens = [];
    for (const [uid, entries] of Object.entries(usersTokens)) {
      for (const [tokenId, item] of Object.entries(entries || {})) {
        if (item?.token && !vistos.has(item.token)) { vistos.add(item.token); tokens.push({ uid, tokenId, token: item.token }); }
      }
    }
    log("Master: aparelhos:", tokens.length);

    const baseLink = link ? (link.startsWith("/") ? N.urlDoApp(process.env.APP_URL || "", link) : link) : N.urlDoApp(process.env.APP_URL || "", "index.html");
    const https = baseLink.startsWith("https://");
    if (!tokens.length) return res.json({ ok: true, campanhaId: campanha, enviados: 0, falhas: 0, tokens: 0, semToken: true });

    const enviados = [], falhas = [], invalidos = [];
    for (let inicio = 0; inicio < tokens.length; inicio += 500) {
      const lote = tokens.slice(inicio, inicio + 500);
      const messages = lote.map(item => ({
        token: item.token,
        notification: { title: titulo, body: corpo },
        data: { tipo: "master", campanhaId: campanha, url: baseLink, link: baseLink, tag: `master:${campanha}` },
        webpush: { notification: { tag: `master:${campanha}` }, ...(https ? { fcmOptions: { link: baseLink } } : {}) }
      }));
      try {
        const response = await comTimeout(admin.messaging().sendEach(messages), 30000, "Envio FCM Master");
        response.responses.forEach((r, i) => {
          const item = lote[i];
          if (r.success) { enviados.push(r.messageId); return; }
          const code = r.error?.code || "unknown";
          falhas.push({ uid: item.uid, tokenId: item.tokenId, code, message: r.error?.message || "Falha FCM." });
          if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) invalidos.push(item);
        });
      } catch (err) {
        console.error("[NotPush] Master FCM lote erro:", err.message);
        for (const item of lote) falhas.push({ uid: item.uid, tokenId: item.tokenId, code: err?.code || "batch-error", message: err?.message || String(err) });
      }
    }
    for (const item of invalidos) {
      await db().ref(`fcm_tokens/${item.uid}/${item.tokenId}`).remove().catch(() => {});
      await db().ref(`fcm_token_owner/${item.tokenId}`).remove().catch(() => {});
    }
    const resultado = { enviados: enviados.length, falhas: falhas.length, tokens: tokens.length, semToken: false, messageIds: enviados.slice(0, 20), erros: falhas.slice(0, 50) };
    await db().ref(`notificaciones_master/${campanha}`).set({ criadoEm: new Date().toISOString(), porUid: req.user.uid, titulo, corpo, link: baseLink, resultado });
    log("MASTER RESULTADO:", JSON.stringify({ ...resultado, messageIds: undefined, erros: undefined }));
    return res.json({ ok: falhas.length === 0, campanhaId: campanha, ...resultado });
  } catch (err) { return erroInterno(res, "/notificar-master", err); }
});

// ---------------- V7.3: cadastro de lojista ----------------
// 'novo'      → o próprio lojista acabou de enviar o cadastro: avisa os aparelhos dos Masters (1 vez por envio).
// 'analisado' → o Master aprovou/recusou: avisa o lojista por push e por e-mail (cada um 1 vez por decisão).
// O e-mail sai pelo Resend (https://resend.com) quando RESEND_API_KEY e EMAIL_FROM estão configurados; sem eles só o push é enviado.
async function enviarEmail({ para, assunto, texto }) {
  const chave = String(process.env.RESEND_API_KEY || "").trim(), de = String(process.env.EMAIL_FROM || "").trim();
  if (!chave || !de) return { enviado: false, motivo: "e-mail não configurado no servidor" };
  if (!para) return { enviado: false, motivo: "o lojista não tem e-mail na conta" };
  try {
    const r = await comTimeout(fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: de, to: [para], subject: assunto, text: texto })
    }), 15000, "Envio de e-mail");
    if (!r.ok) { console.error("[NotPush] e-mail recusado:", r.status, await r.text().catch(() => "")); return { enviado: false, motivo: `o serviço de e-mail recusou (${r.status})` }; }
    return { enviado: true };
  } catch (err) { console.error("[NotPush] e-mail erro:", err.message); return { enviado: false, motivo: "falha ao enviar o e-mail" }; }
}

/** Marca um envio como feito (transação): devolve false se já existia. */
async function reservarUnico(caminho) {
  const t = await db().ref(caminho).transaction(atual => (atual ? undefined : { reservadoEm: Date.now() }));
  return t.committed;
}

app.post("/notificar-cadastro", autenticar, async (req, res) => {
  try {
    const uid = req.user.uid;
    if (!limite("cad:" + uid)) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um minuto." });
    const evento = String(req.body?.evento || "");

    if (evento === "novo") {
      const cad = await lerValor(`lojistas_cadastro/${uid}`);
      if (!cad || cad.status !== "pendente") return res.status(404).json({ ok: false, error: "Cadastro pendente não encontrado." });
      const chave = N.chaveCadastro("novo", cad);
      if (!chave) return res.status(409).json({ ok: false, error: "Cadastro sem data de envio." });
      const caminho = `notificaciones_cadastros/${uid}/${chave}`;
      if (!(await reservarUnico(caminho))) return res.json({ ok: true, evento, duplicado: true });
      const admins = (await lerValor("admins")) || {};
      const masters = Object.entries(admins).filter(([, a]) => a?.role === "master").map(([m]) => m);
      const aviso = N.avisoCadastro("novo", cad);
      let enviados = 0, falhas = 0;
      for (const m of masters) {
        try { const r = await enviarParaUsuario(m, aviso, { tipo: "cadastro", evento: "novo", lojistaUid: uid, tag: `cadastro:${uid}:novo` }); enviados += r.enviados; falhas += r.falhas; }
        catch (err) { falhas++; console.error("[NotPush] cadastro novo → master:", err.message); }
      }
      await db().ref(caminho).set({ criadoEm: new Date().toISOString(), porUid: uid, resultado: { masters: masters.length, enviados, falhas } });
      log("CADASTRO novo:", uid, JSON.stringify({ masters: masters.length, enviados, falhas }));
      return res.json({ ok: true, evento, masters: masters.length, enviados, falhas });
    }

    if (evento === "analisado") {
      if ((await lerValor(`admins/${uid}/role`)) !== "master") return res.status(403).json({ ok: false, error: "Usuário não é Master." });
      const alvo = req.body?.uid;
      if (!idSeguro(alvo)) return res.status(400).json({ ok: false, error: "Lojista inválido." });
      const cad = await lerValor(`lojistas_cadastro/${alvo}`);
      if (!cad || (cad.status !== "aprovado" && cad.status !== "recusado")) return res.status(409).json({ ok: false, error: "O cadastro ainda não foi decidido." });
      const chave = N.chaveCadastro("analisado", cad);
      if (!chave) return res.status(409).json({ ok: false, error: "Cadastro sem data de análise." });
      const base = `notificaciones_cadastros/${alvo}/${chave}`;

      let push = { duplicado: true };
      if (await reservarUnico(`${base}_push`)) {
        try { push = await enviarParaUsuario(alvo, N.avisoCadastro("analisado", cad), { tipo: "cadastro", evento: cad.status, tag: `cadastro:${alvo}:${cad.status}` }); }
        catch (err) { console.error("[NotPush] cadastro push:", err.message); push = { enviados: 0, falhas: 1 }; await db().ref(`${base}_push`).remove().catch(() => {}); }
      }
      let email = { duplicado: true };
      if (await reservarUnico(`${base}_email`)) {
        let para = "";
        try { para = (await admin.auth().getUser(alvo)).email || ""; } catch { /* usa o e-mail do cadastro */ }
        const t = N.emailCadastro(cad, process.env.APP_URL || "");
        email = await enviarEmail({ para: para || cad.email || "", assunto: t.assunto, texto: t.texto });
        if (!email.enviado) await db().ref(`${base}_email`).remove().catch(() => {});   // libera nova tentativa se não saiu
      }
      log("CADASTRO analisado:", alvo, cad.status, JSON.stringify({ push: push.enviados, email: email.enviado }));
      return res.json({ ok: true, evento, status: cad.status, push: { enviados: push.enviados || 0, falhas: push.falhas || 0, duplicado: !!push.duplicado }, email: { enviado: !!email.enviado, motivo: email.motivo || null, duplicado: !!email.duplicado } });
    }

    return res.status(400).json({ ok: false, error: "Evento inválido. Use novo ou analisado." });
  } catch (err) { return erroInterno(res, "/notificar-cadastro", err); }
});

// ---------------- Aviso automático de cupom (V7.1) ----------------
// A loja cadastra um cupom e o NotPush avisa, no máximo 1 vez por dia por loja, os clientes que já pediram nela.
// Tudo é conferido aqui no servidor: dono da loja, cupom ativo, loja não suspensa, chave e teto do Master.
app.post("/notificar-cupom", autenticar, async (req, res) => {
  let reservaDia = null, reservaCupom = null;
  const liberar = async () => {
    if (reservaDia) await db().ref(reservaDia).remove().catch(() => {});
    if (reservaCupom) await db().ref(reservaCupom).remove().catch(() => {});
  };
  try {
    const { lojaId, cupomId } = req.body || {};
    const uid = req.user.uid;
    if (!limite("cup:" + uid)) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um minuto." });
    if (!idSeguro(lojaId) || !idSeguro(cupomId)) return res.status(400).json({ ok: false, error: "Loja ou cupom inválido." });

    const loja = await lerValor(`restaurantes/${lojaId}`);
    if (!loja || !loja.ownerUid) return res.status(404).json({ ok: false, error: "Loja não encontrada." });
    if (loja.ownerUid !== uid) return res.status(403).json({ ok: false, error: "Usuário não é proprietário desta loja." });
    if (loja.activo === false || (await lerValor(`lojas_suspensas/${lojaId}`)) != null) return res.json({ ok: true, enviados: 0, tokens: 0, motivo: "loja-inativa", mensagem: "A loja está desativada, então o aviso não foi enviado." });

    const cupom = await lerValor(`restaurantes/${lojaId}/cupones/${cupomId}`);
    if (!cupom) return res.status(404).json({ ok: false, error: "Cupom não encontrado." });
    if (!N.cupomElegivel(cupom)) return res.json({ ok: true, enviados: 0, tokens: 0, motivo: "cupom-inativo", mensagem: "O cupom está inativo ou incompleto, então o aviso não foi enviado." });

    const cfg = N.configCupom(await lerValor("config_plataforma/push_cupom"));
    if (!cfg.ativo) return res.json({ ok: true, enviados: 0, tokens: 0, motivo: "desligado", mensagem: "O aviso automático de cupom está desligado pela plataforma." });

    const agora = Date.now();
    const dia = N.diaBrasilia(agora);

    // 1 aviso por dia por loja e 1 por cupom (transações: duas chamadas simultâneas não passam as duas)
    reservaCupom = `notificaciones_cupons/${lojaId}/${cupomId}`;
    const rc = await reservar(reservaCupom);
    if (!rc.ok) { reservaCupom = null; return res.json({ ok: true, enviados: 0, tokens: 0, motivo: "cupom-ja-avisado", mensagem: "Este cupom já foi avisado aos clientes." }); }
    reservaDia = `notificaciones_cupons_dia/${dia}/${lojaId}`;
    const rd = await reservar(reservaDia);
    if (!rd.ok) { reservaDia = null; await liberar(); return res.json({ ok: true, enviados: 0, tokens: 0, motivo: "limite-loja", mensagem: "Esta loja já avisou clientes sobre um cupom hoje. Tente amanhã." }); }

    // Público: quem já pediu nesta loja (pedidos recentes), sem contas bloqueadas
    const snap = await db().ref("pedidos").orderByChild("lojaId").equalTo(lojaId).limitToLast(N.MAX_PEDIDOS_PUBLICO).once("value");
    const bloqueados = (await lerValor("usuarios_bloqueados")) || {};
    const clientes = N.publicoDaLoja(snap.val(), bloqueados);

    const tokensTodos = [];
    const vistos = new Set();
    for (const cli of clientes) {
      const obj = (await lerValor(`fcm_tokens/${cli}`)) || {};
      for (const [tokenId, v] of Object.entries(obj)) {
        if (v?.token && !vistos.has(v.token)) { vistos.add(v.token); tokensTodos.push({ uid: cli, tokenId, token: v.token }); }
      }
    }
    if (!tokensTodos.length) {
      await liberar(); // ninguém para avisar: não gasta o aviso do dia
      return res.json({ ok: true, clientes: clientes.length, enviados: 0, tokens: 0, motivo: "sem-aparelhos", mensagem: clientes.length ? "Nenhum cliente desta loja com notificações ativadas ainda." : "Esta loja ainda não tem clientes com pedidos." });
    }

    // Teto diário da plataforma (soma das lojas)
    let permitidos = 0;
    const t = await db().ref(`notificaciones_cupons_total/${dia}`).transaction(atual => {
      const restante = N.restanteDoDia(cfg.limiteDiario, atual?.aparelhos);
      permitidos = Math.min(restante, tokensTodos.length);
      if (permitidos <= 0) return undefined;
      return { aparelhos: (Number(atual?.aparelhos) || 0) + permitidos };
    });
    if (!t.committed || permitidos <= 0) { await liberar(); return res.json({ ok: true, enviados: 0, tokens: tokensTodos.length, motivo: "teto-diario", mensagem: "O teto diário de avisos da plataforma foi atingido. Tente amanhã." }); }
    const tokens = tokensTodos.slice(0, permitidos);

    const aviso = N.montarAvisoCupom({ lojaId, loja, cupom });
    const baseLink = N.urlDoApp(process.env.APP_URL || "", aviso.caminho);
    const https = baseLink.startsWith("https://");
    const icone = https ? N.urlDoApp(process.env.APP_URL, "icons/icons-192.png") : undefined;
    const tag = `cupom:${lojaId}:${cupomId}`;
    const enviados = [], falhas = [], invalidos = [];
    for (let inicio = 0; inicio < tokens.length; inicio += 500) {
      const lote = tokens.slice(inicio, inicio + 500);
      const messages = lote.map(item => ({
        token: item.token,
        notification: { title: aviso.titulo, body: aviso.corpo },
        data: { tipo: "cupom", lojaId, cupomId, url: baseLink, link: baseLink, tag },
        webpush: { notification: { ...(icone ? { icon: icone, badge: icone } : {}), tag }, ...(https ? { fcmOptions: { link: baseLink } } : {}) }
      }));
      try {
        const response = await comTimeout(admin.messaging().sendEach(messages), 30000, "Envio FCM Cupom");
        response.responses.forEach((r, i) => {
          const item = lote[i];
          if (r.success) { enviados.push(r.messageId); return; }
          const code = r.error?.code || "unknown";
          falhas.push({ uid: item.uid, tokenId: item.tokenId, code });
          if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) invalidos.push(item);
        });
      } catch (err) {
        console.error("[NotPush] Cupom FCM lote erro:", err.message);
        for (const item of lote) falhas.push({ uid: item.uid, tokenId: item.tokenId, code: err?.code || "batch-error" });
      }
    }
    for (const item of invalidos) {
      await db().ref(`fcm_tokens/${item.uid}/${item.tokenId}`).remove().catch(() => {});
      await db().ref(`fcm_token_owner/${item.tokenId}`).remove().catch(() => {});
    }
    // V7.3.1: o motivo de cada falha (ex.: messaging/registration-token-not-registered) agora aparece no log e na resposta.
    const codigos = {};
    for (const f of falhas) codigos[f.code] = (codigos[f.code] || 0) + 1;
    const resultado = { clientes: clientes.length, tokens: tokens.length, enviados: enviados.length, falhas: falhas.length, cortadoPeloTeto: tokens.length < tokensTodos.length, ...(falhas.length ? { codigos, removidos: invalidos.length } : {}) };
    const registro = { criadoEm: new Date().toISOString(), porUid: uid, resultado };
    await db().ref(`notificaciones_cupons/${lojaId}/${cupomId}`).set(registro);
    await db().ref(`notificaciones_cupons_dia/${dia}/${lojaId}`).set({ ...registro, cupomId });
    reservaDia = null; reservaCupom = null;
    log("CUPOM RESULTADO:", lojaId, cupomId, JSON.stringify(resultado));
    const extra = resultado.falhas ? ` ${resultado.falhas} aparelho(s) não receberam${resultado.removidos ? " (notificação desativada ou aparelho antigo: já saiu da lista)" : ""}.` : "";
    return res.json({ ok: true, ...resultado, mensagem: `Aviso enviado para ${resultado.enviados} aparelho(s) de clientes da loja.${extra}` });
  } catch (err) {
    await liberar();
    return erroInterno(res, "/notificar-cupom", err);
  }
});

const PORT = process.env.PORT || 10000;
if (require.main === module || process.env.NOTPUSH_FORCE_LISTEN) {
  app.listen(PORT, () => log(`notpush-delivery ${VERSAO} ouvindo na porta ${PORT}`));
}
module.exports = { app, montarMensagem };
