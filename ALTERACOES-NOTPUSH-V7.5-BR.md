# NotPush V7.5.0 — aviso de mensagem na conversa do pedido

## Nova rota `POST /notificar-chat` (com o login do Firebase, como as outras)
O site chama a rota logo depois de gravar uma mensagem na conversa do pedido, enviando `{ pedidoKey, mensagemId }`.

**O que o NotPush confere no banco:**
- quem chamou é **o cliente do pedido** ou **o dono da loja** (senão, 403);
- a mensagem existe e é **dessa pessoa e desse lado** (senão, 404);
- a mensagem é **recente**, de até 10 min (senão, 409);
- o outro lado **ainda não leu**. Se já leu, por exemplo porque está com a conversa aberta, não avisa;
- **no máximo 1 aviso a cada 2 minutos** por conversa e por destino. Quem controla isso é `notificaciones_chat/{pedido}/{cliente|loja}`, com transação, então duas chamadas juntas não mandam dois avisos.

**Avisos:**
| Para | Título | Texto | Ao tocar |
|---|---|---|---|
| Cliente | 💬 Uai Crep's te mandou uma mensagem | Pedido #ABC123: Acabou o crepe de banana… | `status.html?num=ABC123&chat=1` (abre a conversa) |
| Loja | 💬 Mensagem do cliente · Pedido #ABC123 | Ana: Pode trocar o suco? | `admin-loja.html?chat={pedido}` (painel já na conversa) |

- Se chegaram várias mensagens desde a última leitura: "3 mensagens novas · última mensagem".
- A prévia tem até 90 caracteres, numa linha, com **telefones, links, e-mails e @perfis escondidos** (mesma regra do site).
- Todos os avisos da mesma conversa usam a mesma marca (`chat-{pedido}`): o novo substitui o anterior e toca de novo.

## Arquivos
- `notificacoes.js`: regras da conversa (prévia, destino, decisão, textos).
- `serve.js`: rota `/notificar-chat`, toque de novo (renotify) para a conversa, `VERSAO` 7.5.0.
- `tests/chat.test.cjs` (novo) e `package.json` 7.5.0.

## Variáveis
Nenhuma nova. Os avisos da loja usam `APP_URL_PAINEL`, quando ela estiver configurada.

## Publicar
Precisa do site **V75.209**, que chama a rota e abre a conversa pelo link.
