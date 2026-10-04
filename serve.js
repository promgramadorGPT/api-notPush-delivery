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

// ===============================
// Firebase Admin
// ===============================
let firebaseReady = false;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

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
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = decoded;
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
  return evento === "aceptado" || evento === "despachado";
}

// ===============================
// Health
// ===============================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "notpush-delivery"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "notpush-delivery",
    firebase: firebaseReady,
    time: new Date().toISOString()
  });
});

// ===============================
// Registrar token FCM
// ===============================
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

    return res.json({
      ok: true,
      uid,
      tokenId
    });
  } catch (err) {
    console.error("[NotPush] Erro /registrar-token:", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// ===============================
// Remover token FCM
// ===============================
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

// ===============================
// Notificar cliente sobre pedido
// ===============================
app.post("/notificar-pedido", autenticar, async (req, res) => {
  try {
    const { pedidoKey, evento } = req.body;

    log("Pedido recebido:", pedidoKey, "evento:", evento, "por:", req.user.uid);

    if (!pedidoKey) {
      return res.status(400).json({
        ok: false,
        error: "pedidoKey ausente."
      });
    }

    if (!eventoValido(evento)) {
      return res.status(400).json({
        ok: false,
        error: "Evento inválido. Use aceptado ou despachado."
      });
    }

    const pedidoSnap = await db().ref(`pedidos/${pedidoKey}`).once("value");
    const pedido = pedidoSnap.val();

    if (!pedido) {
      return res.status(404).json({
        ok: false,
        error: "Pedido não encontrado."
      });
    }

    const lojaSnap = await db().ref(`restaurantes/${pedido.lojaId}`).once("value");
    const loja = lojaSnap.val();

    if (!loja || loja.ownerUid !== req.user.uid) {
      return res.status(403).json({
        ok: false,
        error: "Usuário não é proprietário da loja deste pedido."
      });
    }

    const destinoUid = pedido.clienteUid;

    if (!destinoUid) {
      return res.status(400).json({
        ok: false,
        error: "Pedido sem clienteUid."
      });
    }

    const tokensSnap = await db().ref(`fcm_tokens/${destinoUid}`).once("value");
    const tokensObj = tokensSnap.val() || {};

    const tokens = Object.values(tokensObj)
      .map(item => item?.token)
      .filter(Boolean);

    log("Tokens encontrados:", tokens.length, "para:", destinoUid);

    const titulo =
      evento === "aceptado"
        ? "Pedido aceptado"
        : "Pedido despachado";

    const corpo =
      evento === "aceptado"
        ? "Tu pedido fue aceptado por la tienda."
        : "Tu pedido ya está en camino.";

    let enviados = 0;
    let falhas = 0;
    const invalidos = [];

    if (tokens.length > 0) {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
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
      });

      enviados = response.successCount;
      falhas = response.failureCount;

      response.responses.forEach((item, index) => {
        if (!item.success) {
          const code = item.error?.code || "";
          if (
            code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token")
          ) {
            invalidos.push(tokens[index]);
          }
          console.error(
            "[NotPush] Falha FCM:",
            code,
            item.error?.message || ""
          );
        }
      });

      for (const token of invalidos) {
        await db().ref(`fcm_tokens/${destinoUid}/${hashToken(token)}`).remove();
      }
    }

    const registro = {
      criadoEm: new Date().toISOString(),
      destinoUid,
      porUid: req.user.uid,
      resultado: {
        enviados,
        falhas,
        tokens: tokens.length,
        semToken: tokens.length === 0
      }
    };

    await db().ref(`notificaciones_pedidos/${pedidoKey}/${evento}`).set(registro);

    return res.json({
      ok: true,
      pedidoKey,
      evento,
      destinoUid,
      ...registro.resultado
    });
  } catch (err) {
    console.error("[NotPush] Erro /notificar-pedido:", err);
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
