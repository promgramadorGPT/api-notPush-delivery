const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(helmet());
app.use(express.json());

function log(...args) {
  console.log("[NotPush]", ...args);
}

let firebaseReady = false;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não configurado.");

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });

  firebaseReady = true;
  log("Firebase Admin conectado.");
} catch (err) {
  console.error("[NotPush] Erro ao inicializar Firebase:", err.message);
}

const db = () => admin.database();

async function autenticar(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        error: "Token Firebase ausente."
      });
    }

    const idToken = header.slice(7);
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (err) {
    console.error("[NotPush] Falha auth:", err.message);
    return res.status(401).json({
      ok: false,
      error: "Token Firebase inválido."
    });
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function eventoValido(evento) {
  return evento === "novo" || evento === "aceptado" || evento === "despachado";
}

function comTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms.`)), ms)
    )
  ]);
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "notpush-delivery" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "notpush-delivery",
    firebase: firebaseReady,
    time: new Date().toISOString()
  });
});

app.post("/registrar-token", autenticar, async (req, res) => {
  try {
    const { token, plataforma = "web" } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Token FCM ausente."
      });
    }

    const uid = req.user.uid;
    const tokenId = hashToken(token);

    await db().ref(`fcm_tokens/${uid}/${tokenId}`).set({
      token,
      plataforma,
      uid,
      atualizadoEm: new Date().toISOString()
    });

    log("Token registrado:", uid, tokenId);

    return res.json({ ok: true, uid, tokenId });
  } catch (err) {
    console.error("[NotPush] Erro /registrar-token:", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/remover-token", autenticar, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Token FCM ausente."
      });
    }

    const uid = req.user.uid;
    const tokenId = hashToken(token);

    await db().ref(`fcm_tokens/${uid}/${tokenId}`).remove();

    log("Token removido:", uid, tokenId);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[NotPush] Erro /remover-token:", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/notificar-pedido", autenticar, async (req, res) => {
  try {
    const { pedidoKey, evento } = req.body;

    log("========================================");
    log("Pedido recebido:", pedidoKey);
    log("Evento:", evento);
    log("Por UID:", req.user.uid);

    if (!pedidoKey) {
      return res.status(400).json({
        ok: false,
        error: "pedidoKey ausente."
      });
    }

    if (!eventoValido(evento)) {
      return res.status(400).json({
        ok: false,
        error: "Evento inválido. Use novo, aceptado ou despachado."
      });
    }

    log("Lendo pedido no Firebase...");
    const pedidoSnap = await db().ref(`pedidos/${pedidoKey}`).once("value");
    const pedido = pedidoSnap.val();

    if (!pedido) {
      return res.status(404).json({
        ok: false,
        error: "Pedido não encontrado."
      });
    }

    log("Pedido encontrado. lojaId:", pedido.lojaId);

    const lojaSnap = await db().ref(`restaurantes/${pedido.lojaId}`).once("value");
    const loja = lojaSnap.val();

    if (!loja || !loja.ownerUid) {
      return res.status(404).json({
        ok: false,
        error: "Loja do pedido não encontrada ou sem ownerUid."
      });
    }

    let destinoUid;

    if (evento === "novo") {
      // O cliente criou o pedido: somente o próprio cliente pode disparar
      // esta notificação, e o destino é o dono da loja.
      if (pedido.clienteUid !== req.user.uid) {
        return res.status(403).json({
          ok: false,
          error: "Usuário não é o cliente deste pedido."
        });
      }
      destinoUid = loja.ownerUid;
    } else {
      // Aceitado/despachado: somente o dono da loja pode disparar,
      // e o destino é o cliente do pedido.
      if (loja.ownerUid !== req.user.uid) {
        return res.status(403).json({
          ok: false,
          error: "Usuário não é proprietário da loja deste pedido."
        });
      }
      destinoUid = pedido.clienteUid;
    }

    if (!destinoUid) {
      return res.status(400).json({
        ok: false,
        error: "Destino da notificação não encontrado."
      });
    }

    log("Destino UID:", destinoUid);
    log("Buscando tokens...");

    const tokensSnap = await db().ref(`fcm_tokens/${destinoUid}`).once("value");
    const tokensObj = tokensSnap.val() || {};

    const tokens = Object.values(tokensObj)
      .map(item => item?.token)
      .filter(Boolean);

    log("Tokens encontrados:", tokens.length, "para:", destinoUid);

    if (tokens.length === 0) {
      const registroSemToken = {
        criadoEm: new Date().toISOString(),
        destinoUid,
        porUid: req.user.uid,
        resultado: {
          enviados: 0,
          falhas: 0,
          tokens: 0,
          semToken: true
        }
      };

      await db().ref(`notificaciones_pedidos/${pedidoKey}/${evento}`).set(registroSemToken);

      log("Nenhum token. Encerrando envio.");
      return res.json({
        ok: true,
        pedidoKey,
        evento,
        destinoUid,
        ...registroSemToken.resultado
      });
    }

    const titulo = evento === "novo"
      ? "Nuevo pedido"
      : (evento === "aceptado" ? "Pedido aceptado" : "Pedido despachado");

    const corpo = evento === "novo"
      ? `Has recibido un nuevo pedido${pedido.numeroPedido ? ` #${pedido.numeroPedido}` : ""}.`
      : (evento === "aceptado"
        ? "Tu pedido fue aceptado por la tienda."
        : "Tu pedido ya está en camino.");

    const enviados = [];
    const falhas = [];
    const invalidos = [];

    log("Preparando envio FCM para", tokens.length, "token(s)...");
    log("Usando send() individual para diagnóstico.");

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      const message = {
        token,
        notification: {
          title: titulo,
          body: corpo
        },
        data: {
          pedidoKey: String(pedidoKey),
          evento: String(evento),
          url: process.env.APP_URL || "/"
        },
        webpush: {
          fcmOptions: {
            link: process.env.APP_URL || "/"
          }
        }
      };

      log(`Enviando FCM ${i + 1}/${tokens.length}...`);

      try {
        const messageId = await comTimeout(
          admin.messaging().send(message),
          20000,
          "Envio FCM"
        );

        enviados.push(messageId);
        log(`FCM OK ${i + 1}/${tokens.length}:`, messageId);
      } catch (err) {
        const code = err?.code || "unknown";
        const messageText = err?.message || String(err);

        falhas.push({
          index: i,
          code,
          message: messageText
        });

        console.error(`[NotPush] FCM ERRO ${i + 1}/${tokens.length}:`, code, messageText);

        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          invalidos.push(token);
        }
      }
    }

    for (const token of invalidos) {
      await db().ref(`fcm_tokens/${destinoUid}/${hashToken(token)}`).remove();
      log("Token inválido removido.");
    }

    const registro = {
      criadoEm: new Date().toISOString(),
      destinoUid,
      porUid: req.user.uid,
      resultado: {
        enviados: enviados.length,
        falhas: falhas.length,
        tokens: tokens.length,
        semToken: false,
        messageIds: enviados,
        erros: falhas
      }
    };

    await db().ref(`notificaciones_pedidos/${pedidoKey}/${evento}`).set(registro);

    log("RESULTADO FINAL:", JSON.stringify(registro.resultado));
    log("========================================");

    return res.json({
      ok: falhas.length === 0,
      pedidoKey,
      evento,
      destinoUid,
      ...registro.resultado
    });
  } catch (err) {
    console.error("[NotPush] ERRO GERAL /notificar-pedido:", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  log(`notpush-delivery ouvindo na porta ${PORT}`);
});
