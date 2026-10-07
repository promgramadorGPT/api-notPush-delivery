// NotPush Delivery V7 — BR. Rotas e autenticação (Firebase ID Token) mantidas da V6; regras puras em notificacoes.js.
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const admin = require("firebase-admin");
const crypto = require("crypto");
const N = require("./notificacoes");

const VERSAO = "7.0.0";
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
    return res.json({ ok: r.resultado.falhas === 0, pedidoKey, evento, destinoUid: d.destinoUid, ...r.resultado });
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

const PORT = process.env.PORT || 10000;
if (require.main === module || process.env.NOTPUSH_FORCE_LISTEN) {
  app.listen(PORT, () => log(`notpush-delivery ${VERSAO} ouvindo na porta ${PORT}`));
}
module.exports = { app, montarMensagem };
