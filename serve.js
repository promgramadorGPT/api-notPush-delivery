const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON não configurado.');
  const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://app-delivery-frontend-da5d0-default-rtdb.firebaseio.com'
  });
}
initFirebase();
const db = admin.database();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function authUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ ok:false, error:'Token Firebase ausente.' });
    req.user = await admin.auth().verifyIdToken(header.slice(7));
    next();
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(401).json({ ok:false, error:'Token Firebase inválido ou expirado.' });
  }
}

function dadosEvento(evento) {
  const mapa = {
    novo: { title:'Nuevo pedido 🔔', body:'Tienes un nuevo pedido pendiente.' },
    aceptado: { title:'¡Pedido aceptado! 🎉', body:'La tienda aceptó tu pedido y ya lo está preparando.' },
    despachado: { title:'¡Pedido en camino! 🛵', body:'Tu pedido salió para entrega.' }
  };
  return mapa[evento] || null;
}

async function tokensDoUsuario(uid) {
  const snap = await db.ref(`fcm_tokens/${uid}`).once('value');
  const dados = snap.val() || {};
  return Object.entries(dados).map(([key, value]) => ({ key, ...(value || {}) })).filter(x => x.token);
}

async function enviarParaUsuario(uid, evento, link) {
  const registros = await tokensDoUsuario(uid);
  if (!registros.length) return { enviados:0, tokens:0, semToken:true };
  const info = dadosEvento(evento);
  const tokens = registros.map(x => x.token);
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: info.title, body: info.body },
    data: { evento, link: String(link || process.env.APP_URL || '/') },
    webpush: { fcmOptions: { link: String(link || process.env.APP_URL || '/') } }
  });

  const invalidos = [];
  response.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
      invalidos.push(registros[i].key);
    }
  });
  await Promise.all(invalidos.map(key => db.ref(`fcm_tokens/${uid}/${key}`).remove().catch(()=>{})));
  return { enviados: response.successCount, falhas: response.failureCount, tokens: tokens.length, removidos: invalidos.length };
}

async function pedido(pedidoKey) {
  if (!pedidoKey) return null;
  const snap = await db.ref(`pedidos/${pedidoKey}`).once('value');
  return snap.exists() ? { key: pedidoKey, ...(snap.val() || {}) } : null;
}

async function loja(lojaId) {
  if (!lojaId) return null;
  const snap = await db.ref(`restaurantes/${lojaId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

app.get('/health', (_req, res) => res.json({ ok:true, service:'notpush-delivery', firebase:admin.apps.length>0, time:new Date().toISOString() }));

app.post('/registrar-token', authUser, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token || token.length < 20) return res.status(400).json({ ok:false, error:'Token FCM inválido.' });
    const key = hashToken(token);
    await db.ref(`fcm_tokens/${req.user.uid}/${key}`).update({ token, plataforma:String(req.body?.plataforma || 'web'), atualizadoEm:new Date().toISOString() });
    res.json({ ok:true, uid:req.user.uid, key });
  } catch (err) {
    console.error('[registrar-token]', err);
    res.status(500).json({ ok:false, error:'Não foi possível registrar o token.' });
  }
});

app.post('/remover-token', authUser, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ ok:false, error:'Token FCM ausente.' });
    await db.ref(`fcm_tokens/${req.user.uid}/${hashToken(token)}`).remove();
    res.json({ ok:true });
  } catch (err) {
    console.error('[remover-token]', err);
    res.status(500).json({ ok:false, error:'Não foi possível remover o token.' });
  }
});

app.post('/notificar-pedido', authUser, async (req, res) => {
  try {
    const pedidoKey = String(req.body?.pedidoKey || '').trim();
    const evento = String(req.body?.evento || '').trim();
    if (!pedidoKey || !dadosEvento(evento)) return res.status(400).json({ ok:false, error:'pedidoKey ou evento inválido.' });

    const p = await pedido(pedidoKey);
    if (!p) return res.status(404).json({ ok:false, error:'Pedido não encontrado.' });

    const lojaDados = await loja(p.lojaId);
    if (!lojaDados) return res.status(404).json({ ok:false, error:'Loja não encontrada.' });

    let destinoUid;
    if (evento === 'novo') {
      if (p.clienteUid !== req.user.uid) return res.status(403).json({ ok:false, error:'Você não é o cliente deste pedido.' });
      destinoUid = lojaDados.ownerUid;
    } else {
      if (lojaDados.ownerUid !== req.user.uid) return res.status(403).json({ ok:false, error:'Você não administra esta loja.' });
      destinoUid = p.clienteUid;
    }
    if (!destinoUid) return res.status(400).json({ ok:false, error:'Usuário destinatário não encontrado.' });

    const marker = db.ref(`notificaciones_pedidos/${pedidoKey}/${evento}`);
    const markerSnap = await marker.once('value');
    if (markerSnap.exists()) return res.json({ ok:true, duplicado:true, destinoUid });

    const link = process.env.APP_URL || '/';
    const resultado = await enviarParaUsuario(destinoUid, evento, link);
    await marker.set({ criadoEm:new Date().toISOString(), porUid:req.user.uid, destinoUid, resultado });
    res.json({ ok:true, evento, pedidoKey, destinoUid, ...resultado });
  } catch (err) {
    console.error('[notificar-pedido]', err);
    res.status(500).json({ ok:false, error:'Erro ao enviar notificação.' });
  }
});

app.use((_req, res) => res.status(404).json({ ok:false, error:'Rota não encontrada.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 notpush-delivery ouvindo na porta ${PORT}`));
