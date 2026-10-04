# notpush-delivery v2

API separada para notificações YAPOOD.

## Render

Build/Start:
npm install
npm start

Variáveis:
- FIREBASE_DATABASE_URL
- FIREBASE_SERVICE_ACCOUNT_JSON
- APP_URL

Rotas:
GET /
GET /health
POST /registrar-token
POST /remover-token
POST /notificar-pedido

O endpoint /notificar-pedido recebe:
{
  "pedidoKey": "...",
  "evento": "aceptado"
}

ou:

{
  "pedidoKey": "...",
  "evento": "despachado"
}
