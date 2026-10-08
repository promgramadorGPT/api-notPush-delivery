# NotPush V7.2 — aviso do presente da fidelidade

**O que muda:** quando uma entrega completa a meta da fidelidade do cliente naquela loja, o cliente recebe um segundo push: **"Você ganhou um presente! 🎁 — {Loja} preparou uma surpresa para você. Abra o app para descobrir."** O texto não revela o presente (continua surpresa); tocar no aviso abre `pedidos.html`, onde a caixa de presente abre sozinha com os confetes.

**Como funciona (tudo no servidor):**
- Dispara dentro de `POST /notificar-pedido` com `evento: entregue`, logo depois do aviso "Pedido entregue".
- Só envia se a loja tem fidelidade ligada e válida e se este pedido (que conta para a meta) fez o total de pedidos concluídos do cliente na loja chegar a um múltiplo da meta. Mesmas regras do app: pedido que usou presente, totalmente reembolsado, abaixo do mínimo ou anterior ao início do programa não conta.
- Uma vez por pedido (`notificaciones_pedidos/{pedido}/presente`); repetir a chamada não duplica.
- Se algo falhar nessa parte, o aviso de entrega normal não é afetado.

**Sem mudança** de rotas, variáveis de ambiente ou regras do banco. Subir no mesmo serviço do NotPush no Render (versão 7.2.0).
