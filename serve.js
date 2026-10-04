import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import admin from 'firebase-admin';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const API_KEY = process.env.NOTPUSH_API_KEY || '';

if (!DATABASE_URL) {
  throw new Error('FIREBASE_DATABASE_URL no configurada.');
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no contiene JSON válido.');
    }
  }

  if (process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  throw new Error(
    'Faltan credenciales Firebase. Usa FIREBASE_SERVICE_ACCOUNT_JSON ' +
    'o FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.'
  );
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL
});

const db = admin.database();
const messaging = admin.messaging();

app.use(helmet());
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-NotPush-Key']
}));
app.use(express.json({ limit: '64kb' }));

function clean(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const received = req.get('X-NotPush-Key') || '';
  if (received !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'API key inválida.' });
  }
  next();
}

async function verifyFirebaseUser(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    const err = new Error('Falta Authorization Bearer.');
    err.status = 401;
    throw err;
  }

  const idToken = header.slice(7).trim();
  if (!idToken) {
    const err = new Error('Token Firebase vacío.');
    err.status = 401;
    throw err;
  }

  return admin.auth().verifyIdToken(idToken);
}

function eventInfo(event) {
  const normalized = clean(event, 40).toLowerCase();

  if (normalized === 'aceptado' || normalized === 'accepted') {
    return {
      key: 'aceptado',
      title: 'Pedido aceptado',
      body: 'Tu pedido fue aceptado por la tienda.'
    };
  }

  if (
    normalized === 'despachado' ||
    normalized === 'despachado' ||
    normalized === 'en_camino' ||
    normalized === 'en camino' ||
    normalized === 'dispatched'
  ) {
    return {
      key: 'despachado',
      title: 'Pedido despachado',
      body: 'Tu pedido ya fue despachado y va en camino.'
    };
  }

  return null;
}

async function getOrder(pedidoKey) {
  const snap = await db.ref(`pedidos/${pedidoKey}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function getStore(lojaId) {
  if (!lojaId) return null;
  const snap = await db.ref(`restaurantes/${lojaId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function userOwnsStore(uid, lojaId) {
  const store = await getStore(lojaId);
  return !!store && store.ownerUid === uid;
}

async function getUserTokens(clienteUid) {
  const snap = await db.ref(`fcm_tokens/${clienteUid}`).once('value');
  if (!snap.exists()) return [];

  const value = snap.val();
  const tokens = [];

  for (const [key, item] of Object.entries(value || {})) {
    const token = typeof item === 'string' ? item : item?.token;
    if (typeof token === 'string' && token.trim()) {
      tokens.push({ key, token: token.trim() });
    }
  }

  return tokens;
}

async function deleteInvalidTokens(clienteUid, invalidKeys) {
  if (!invalidKeys.length) return;

  const updates = {};
  for (const key of invalidKeys) {
    updates[`fcm_tokens/${clienteUid}/${key}`] = null;
  }
  await db.ref().update(updates);
}

async function alreadySent(pedidoKey, eventKey) {
  const snap = await db.ref(`notificaciones_pedidos/${pedidoKey}/${eventKey}/enviado`).once('value');
  return snap.val() === true;
}

async function markSent(pedidoKey, eventKey, extra = {}) {
  await db.ref(`notificaciones_pedidos/${pedidoKey}/${eventKey}`).set({
    enviado: true,
    enviadoEm: admin.database.ServerValue.TIMESTAMP,
    ...extra
  });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'notpush-delivery',
    firebase: true,
    time: new Date().toISOString()
  });
});

/*
  Registra/actualiza el token FCM del cliente.

  Requiere:
    Authorization: Bearer <Firebase ID token>

  Body:
    { "token": "FCM_REGISTRATION_TOKEN" }

  Guarda en:
    /fcm_tokens/{clienteUid}/{sha256(token)}
*/
app.post('/registrar-token', async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req);
    const token = clean(req.body?.token, 4096);

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token é obrigatório.' });
    }

    const key = hashToken(token);

    await db.ref(`fcm_tokens/${user.uid}/${key}`).set({
      token,
      plataforma: clean(req.body?.plataforma, 40) || 'web',
      atualizadoEm: admin.database.ServerValue.TIMESTAMP
    });

    return res.json({ ok: true, clienteUid: user.uid });
  } catch (error) {
    console.error('registrar-token:', error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Erro interno.'
    });
  }
});

/*
  Remove um token FCM do usuário autenticado.
*/
app.post('/remover-token', async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req);
    const token = clean(req.body?.token, 4096);

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token é obrigatório.' });
    }

    await db.ref(`fcm_tokens/${user.uid}/${hashToken(token)}`).remove();

    return res.json({ ok: true });
  } catch (error) {
    console.error('remover-token:', error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Erro interno.'
    });
  }
});

/*
  Dispara uma das duas notificações do Delivery.

  Requer:
    Authorization: Bearer <Firebase ID token> do usuário da loja.

  Body:
    {
      "pedidoKey": "CHAVE_PUSH_DO_PEDIDO",
      "evento": "aceptado" | "despachado"
    }

  A API NÃO confia em clienteUid enviado pelo navegador:
  ela lê /pedidos/{pedidoKey}, descobre o clienteUid e envia para
  os tokens cadastrados daquele cliente.

  Também valida que o usuário autenticado é dono da loja do pedido.
*/
app.post('/notificar-pedido', async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req);

    const pedidoKey = clean(req.body?.pedidoKey, 200);
    const info = eventInfo(req.body?.evento);

    if (!pedidoKey) {
      return res.status(400).json({ ok: false, error: 'pedidoKey é obrigatório.' });
    }

    if (!info) {
      return res.status(400).json({
        ok: false,
        error: 'evento inválido. Use "aceptado" ou "despachado".'
      });
    }

    const pedido = await getOrder(pedidoKey);

    if (!pedido) {
      return res.status(404).json({ ok: false, error: 'Pedido não encontrado.' });
    }

    const lojaId = clean(pedido.lojaId, 200);
    const clienteUid = clean(pedido.clienteUid, 200);

    if (!lojaId || !clienteUid) {
      return res.status(422).json({
        ok: false,
        error: 'Pedido sem lojaId ou clienteUid.'
      });
    }

    const ownsStore = await userOwnsStore(user.uid, lojaId);
    if (!ownsStore) {
      return res.status(403).json({
        ok: false,
        error: 'Usuário não autorizado para esta loja.'
      });
    }

    if (await alreadySent(pedidoKey, info.key)) {
      return res.json({
        ok: true,
        duplicate: true,
        evento: info.key,
        message: 'Notificação já enviada anteriormente.'
      });
    }

    const records = await getUserTokens(clienteUid);

    if (!records.length) {
      return res.json({
        ok: true,
        enviado: false,
        motivo: 'cliente_sem_token_fcm',
        evento: info.key
      });
    }

    const tokens = records.map((item) => item.token);

    const message = {
      notification: {
        title: info.title,
        body: info.body
      },
      data: {
        tipo: 'pedido',
        evento: info.key,
        pedidoKey,
        numeroPedido: String(pedido.numeroPedido || '')
      },
      webpush: {
        fcmOptions: {
          link: process.env.APP_URL || 'https://10app-delivery.vercel.app/'
        }
      },
      tokens
    };

    const response = await messaging.sendEachForMulticast(message);

    const invalidKeys = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        const code = result.error?.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token')
        ) {
          invalidKeys.push(records[index].key);
        }
      }
    });

    await deleteInvalidTokens(clienteUid, invalidKeys);

    if (response.successCount > 0) {
      await markSent(pedidoKey, info.key, {
        clienteUid,
        sucesso: response.successCount,
        falhas: response.failureCount
      });
    }

    return res.json({
      ok: response.successCount > 0,
      evento: info.key,
      clienteUid,
      enviados: response.successCount,
      falhas: response.failureCount,
      tokensInvalidosRemovidos: invalidKeys.length
    });
  } catch (error) {
    console.error('notificar-pedido:', error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Erro interno.'
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Rota não encontrada.' });
});

app.listen(PORT, () => {
  console.log(`notpush-delivery ativo na porta ${PORT}`);
});
