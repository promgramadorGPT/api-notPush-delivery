# NotPush 7.7.0 — o servidor conta as vendas do cardápio

## O que mudou
- **Quem conta agora:** o número de vendas de cada item do cardápio (`restaurantes/{loja}/menu/{item}/vendas`) passa a ser contado pelo NotPush, e não mais pelo painel da loja. Esse número é o que dá o selo "🔥 Mais pedida", o chip "Mais pedidas" e os "Pratos mais pedidos" da loja.
- **O que conta:** só pedidos **entregues**. Pedido pendente, em preparo ou cancelado não conta. Se um pedido já contado for cancelado depois (estorno), a venda é desfeita.
- **Pagamento na entrega:** dinheiro e Pix na entrega também contam, porque a contagem lê os pedidos no Firebase e não depende do Mercado Pago.
- **Item fantasma:** item que saiu do cardápio não volta como "fantasma"; o servidor só grava em item que existe.

## Como funciona
1. **Primeira chamada:** faz a recontagem completa de todos os pedidos e corrige o número de cada item. Antes, o painel contava também os pedidos não entregues, então o número pode até baixar.
2. **Chamadas seguintes:** lê só os pedidos criados nos últimos 7 dias.
   - Quem já foi contado fica em `vendas_contagem/pedidos`, e esse registro some depois de 8 dias.
   - Uma trava (`vendas_contagem/trava`, até 2 min) impede que duas chamadas contem juntas.
3. **Quando roda:** a cada chamada do agendador em `POST /cron/ofertas`, a cada 10 min. Também tem a rota `POST /cron/vendas`, com a mesma chave `X-Push-Cron-Chave`.
   - Se a contagem falhar, as ofertas continuam saindo normalmente.
   - **Não precisa mudar** o agendador nem criar chave nova.
4. **Horário:** o agendador roda das 07:00 às 20:59 (Brasília). Pedidos entregues depois disso entram na primeira chamada da manhã.

## Arquivos
- **Novos:**
  - `vendas.js`
  - `tests/vendas.test.cjs`
  - `ALTERACOES-NOTPUSH-V7.7-BR.md`
- **Alterados:**
  - `serve.js`: versão 7.7.0, a rota `/cron/vendas` e a contagem dentro de `/cron/ofertas`
  - `package.json`
  - `README.md`
  - `tests/ofertas.test.cjs`: versão e o falso Firebase com `startAt`

## Junto com
- **Site V75.254:** o painel da loja para de gravar as vendas.
- **Regras do Firebase `RASCUNHO-V75.254`:** só o servidor muda as vendas, e `vendas_contagem` fica fechado.

## Ordem para publicar
1. **NotPush 7.7.0 no Render:** suba os arquivos e espere o deploy terminar.
2. **Site V75.254 no Cloudflare.**
3. **Regras V75.254:** cole no Firebase, em Realtime Database → Regras, e clique em **Publicar**.

Depois da próxima chamada do agendador, o Render mostra no log `VENDAS: recontagem …`.
