# notpush-delivery v2

API central de Push do 10App Delivery.

## Eventos
- `novo`: cliente autenticado cria o pedido -> notifica o ADM da loja.
- `aceptado`: ADM da loja aceita -> notifica o cliente.
- `despachado`: ADM da loja despacha -> notifica o cliente.

## Rotas
- `GET /health`
- `POST /registrar-token` (Firebase ID token)
- `POST /remover-token` (Firebase ID token)
- `POST /notificar-pedido` (Firebase ID token)

A API nunca confia no destinatário enviado pelo navegador: lê o pedido no Firebase e determina o cliente ou `ownerUid` da loja.
