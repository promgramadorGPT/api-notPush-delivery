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

## V7.3.1
- `/notificar-cupom`: quando algum aparelho falha, a resposta e o log `CUPOM RESULTADO` trazem `codigos` (ex.: `messaging/registration-token-not-registered`) e `removidos` (tokens mortos já apagados). A mensagem para a loja avisa quantos aparelhos não receberam.
- Teste novo cobrindo a falha de um aparelho.

## V7.3.2
- **Erro falso ao enviar cupom (corrigido).** Na 7.3.1 o código de erro do aparelho (`messaging/registration-token-not-registered`) era gravado como chave do Firebase, e a `/` é proibida em chave. A gravação do registro falhava **depois** do envio: a loja via erro mesmo com a notificação entregue, e a reserva do dia era liberada (risco de aviso duplicado). Agora: as chaves são saneadas (`/` → `_`); se mesmo assim a gravação falhar, grava um registro mínimo e responde `ok:true`; e, depois que o envio começa, a reserva **não** é mais liberada por falha de gravação.
- **`/notificar-master`**: se salvar o histórico falhar, a resposta continua `ok:true` (a notificação já saiu) e o erro vai para o log.
- **Quadradinho branco no ícone.** O `badge` (ícone pequeno da barra de status do Android) usava o logo opaco, que o Android pinta de branco. Agora usa `icons/badge-96.png` (branco com fundo transparente), enviado em pedidos, cupons e Master (o Master agora também envia `icon`). Requer `APP_URL=https://yapoodbr.vercel.app` no Render e o front V75.52 publicado.
- Testes: banco falso agora rejeita chaves inválidas como o Firebase real; casos novos (chave com `/`, falha ao gravar registro).
