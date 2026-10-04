# notpush-delivery

API separada do projeto de pagamentos Mercado Pago.

## Função

Envia duas notificações FCM para clientes:

- `aceptado` — pedido aceito pela loja
- `despachado` — pedido despachado/enviado

A API lê o pedido diretamente em `/pedidos/{pedidoKey}` e obtém dele:

- `clienteUid`
- `lojaId`
- `numeroPedido`

O navegador não informa o `clienteUid` para a API.

## Estrutura Firebase usada

### Tokens FCM

`/fcm_tokens/{clienteUid}/{sha256-do-token}`

Exemplo:

```json
{
  "token": "TOKEN_FCM",
  "plataforma": "web",
  "atualizadoEm": 1760000000000
}
```

### Controle anti-duplicação

`/notificaciones_pedidos/{pedidoKey}/{evento}`

## Variáveis de ambiente

Veja `.env.example`.

A credencial da Service Account nunca deve entrar no frontend ou no GitHub.

## Endpoints

### GET /health

Verifica se a API está ativa.

### POST /registrar-token

Header:

`Authorization: Bearer FIREBASE_ID_TOKEN`

Body:

```json
{
  "token": "TOKEN_FCM",
  "plataforma": "web"
}
```

### POST /remover-token

Header:

`Authorization: Bearer FIREBASE_ID_TOKEN`

Body:

```json
{
  "token": "TOKEN_FCM"
}
```

### POST /notificar-pedido

Header:

`Authorization: Bearer FIREBASE_ID_TOKEN`

Body:

```json
{
  "pedidoKey": "CHAVE_DO_PEDIDO",
  "evento": "aceptado"
}
```

ou:

```json
{
  "pedidoKey": "CHAVE_DO_PEDIDO",
  "evento": "despachado"
}
```

A API verifica que o Firebase UID autenticado é dono da loja do pedido antes de enviar.

## Observação

Esta API é o servidor FCM. O app ainda precisa ser integrado para:

1. pedir permissão de notificações;
2. obter o token FCM Web;
3. chamar `/registrar-token`;
4. chamar `/notificar-pedido` quando a loja aceitar/despachar.

A configuração do `firebase-messaging-sw.js` também precisa usar o projeto Firebase do 10App.
