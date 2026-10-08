# OAuth Mercado Pago

Rotas (todas exigem Firebase ID Token do dono da loja, exceto o callback):
- `POST /oauth/mp/iniciar` `{lojaId}` -> `{url}` (front redireciona o lojista para essa URL)
- `GET  /oauth/mp/callback` (Mercado Pago redireciona aqui; o servidor troca o `code` por tokens e volta para `FRONTEND_URL/admin-loja.html?mp=ok|erro`)
- `POST /oauth/mp/status` `{lojaId}` -> estado da conexão (nunca devolve o token)
- `POST /oauth/mp/desconectar` `{lojaId}`

Onde fica cada dado:
- `restaurantes_privado/{lojaId}`: `mp_token`, `mp_refresh_token`, `mp_expires_at`, `mp_user_id`, `mp_oauth`
- `restaurantes/{lojaId}`: `mp_public_key`, `mp_conectado` (públicos)
- `oauth_state/{state}`: uso único, 10 min (só o servidor acessa; as regras do banco bloqueiam o front)

O token é renovado automaticamente (7 dias antes de expirar) na primeira vez que for usado. Lojas com token digitado manualmente continuam funcionando.
O `MP_WEBHOOK_SECRET` deve ser o da MESMA aplicação cujo Client ID está em `MP_CLIENT_ID`.
