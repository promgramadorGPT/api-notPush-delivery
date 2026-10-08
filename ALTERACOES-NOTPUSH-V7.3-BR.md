# NotPush V7.3 — avisos do cadastro de lojista

## Nova rota `POST /notificar-cadastro` (exige login Firebase)
- `{ "evento": "novo" }` — chamada pelo **lojista** logo depois de enviar o cadastro. Confere que o cadastro dele existe e está pendente e avisa por push os aparelhos de todos os **Masters** (1 vez por envio; reenviar o cadastro avisa de novo).
- `{ "evento": "analisado", "uid": "<uid do lojista>" }` — chamada pelo **Master** depois de aprovar ou recusar. Avisa o lojista por **push** e por **e-mail** (cada um 1 vez por decisão; se o e-mail falhar, a próxima chamada tenta de novo).

## E-mail (opcional)
Usa o Resend (https://resend.com). Defina no Render:
- `RESEND_API_KEY` — chave da API.
- `EMAIL_FROM` — remetente de um domínio verificado, ex.: `YaPOOD <nao-responda@seudominio.com.br>`.
Sem as duas variáveis a rota continua funcionando e responde `email.enviado=false` com o motivo; só o push sai.
O endereço usado é o e-mail da conta Google do lojista (com o do cadastro como reserva).

## Outras mudanças
- `VERSAO` em `serve.js` estava em 7.1.0 mesmo na V7.2; agora diz **7.3.0** (e `/health` mostra isso).
- Testes: `tests/cadastro.test.cjs` (junto com o `notpush.test.cjs` em `npm test`).
