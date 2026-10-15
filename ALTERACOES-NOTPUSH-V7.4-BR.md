# NotPush V7.4.0 — notificação do pedido por etapa + "o entregador está chegando"

## Uma notificação só por pedido
Os avisos do cliente (aceito, saiu, chegando, entregue) usam a **mesma marca** (`tag = pedido-{pedidoKey}`):
cada aviso novo **substitui** o anterior na bandeja (não acumula), tocando e vibrando de novo (`renotify`).

| Etapa | Título | Texto | Botão |
|---|---|---|---|
| 2 Preparando | 🍳 Pedido sendo preparado | Loja · chega em 30–40 min · #NUM | Ver pedido |
| 3 A caminho | 🛵 Saiu para entrega | Carlos (entregador da loja / parceiro YaPOOD) está a caminho · #NUM | Ver no mapa |
| 4 Chegando | 📍 O entregador está chegando! | Carlos está a menos de 150 m. Prepare-se para receber. | Ver no mapa |
| 5 Entregue | ✅ Pedido entregue | Bom apetite! Toque para avaliar o pedido. | Avaliar |

- Cada aviso leva a **imagem da etapa** (barra das 5 etapas + ícone), servida pelo site em `icons/status/*.png`
  (precisa do site **V75.143** publicado e `APP_URL` em https). No iPhone aparece só o texto.
- O tempo vem de `restaurantes/{id}/tiempoEntrega`; o nome de quem leva, do rastreio ou do cadastro do entregador (só o primeiro nome).
- Os avisos da loja, do entregador, do Master, de cupom e de presente **não mudaram**.

## Nova rota `POST /notificar-chegando` (só a API chama)
- Cabeçalho `X-NotPush-Chave` = variável **`NOTPUSH_CHAVE_INTERNA`** (mín. 16 caracteres, **a mesma** no serviço da API).
  Sem a variável a rota responde 401 (fica fechada).
- Confere no banco: pedido de delivery ainda não entregue/cancelado e `rastreio/{pedido}` com distância **≤ 150 m**
  atualizada há menos de 3 min. Envia **uma vez** por pedido (`notificaciones_pedidos/{pedido}/chegando`).
- A posição do entregador não é lida nem enviada: só a distância arredondada que a API já grava.

## Variáveis no Render (serviço NotPush)
| Variável | Valor |
|---|---|
| `NOTPUSH_CHAVE_INTERNA` | a mesma chave colocada na API (gere uma longa, ex.: 40 caracteres) |

## Arquivos
- `notificacoes.js` — etapas, textos, imagens, regra dos 150 m.
- `serve.js` — imagem/botões/renotify na mensagem, tag do pedido, rota `/notificar-chegando`. `VERSAO` 7.4.0.
- `tests/etapas.test.cjs` (novo) e `tests/notpush.test.cjs` (títulos novos). `package.json` 7.4.0.
