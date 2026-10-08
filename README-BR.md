# api-mp-yapoodbr

API Mercado Pago da versão Brasil do YAPOOD.

## Separação
Esta API usa exclusivamente o projeto Firebase Brasil:
`yapoodbr-delivery`

Realtime Database:
`https://yapoodbr-delivery-default-rtdb.firebaseio.com`

A API do Chile permanece separada e não deve apontar para este banco.

## Render
Nome sugerido do serviço:
`api-mp-yapoodbr`

Variáveis obrigatórias:
- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `ALLOWED_ORIGINS`
- `MP_WEBHOOK_URL`
- `MP_WEBHOOK_SECRET`

## Pagamentos por loja
O Access Token de cada loja continua em:
`restaurantes_privado/{lojaId}/mp_token`

Rotas principais:
- `GET /health`
- `POST /criar-pagamento-loja`
- `POST /criar-pix-loja`
- `GET /status-loja/:lojaId/:paymentId`
- `POST /webhook/mercadopago`

As rotas legadas centrais são mantidas apenas para compatibilidade; o checkout BR deve usar as rotas por loja.
