# API V2.5 — Comissão da plataforma e reembolso

Nada novo em variáveis de ambiente. Arquivos novos: `comissao.js`, `tests/comissao-reembolso.test.cjs`. Alterado: `server.js`, `package.json`.

## Comissão (split)
- % lida de `config_plataforma/comissao/percentual` (Firebase), definida no painel Master. Sem % (ou 0) = pagamento normal.
- Base (V2.7): produtos ANTES de qualquer desconto, sem a entrega (cupom é custo da loja). Taxa sempre menor que o valor cobrado.
- `/criar-pagamento-loja` e `/criar-pix-loja`: se a loja conectou por OAuth (`mp_oauth: true`), envia `application_fee` ao Mercado Pago. Loja com token manual não aceita split: grava `modo: a_acertar`.
- Grava em `pedidos/{pedidoKey}/comissaoPlataforma` { percentual, base, valor, modo, registradaEm }.

## Reembolso — `POST /reembolso/executar` { pedidoKey }
- Auth: Firebase ID Token. Só o dono da loja do pedido.
- Pré-condições: `pedidos/{k}/reembolso.status === 'aprovado'` (a loja decide no painel), pagamento online aprovado (`paymentIdMP`), valor > 0 e <= total, não executado antes. Reembolso pedido pelo cliente é bloqueado se a entrega foi confirmada.
- Chama `POST /v1/payments/{id}/refunds` com o token da própria loja e o valor (total ou parcial). Chave de idempotência por pedido+valor.
- Trava em `reembolso/execucao` (processando → concluido | falhou). Falha libera nova tentativa; sucesso trava.

## A conferir no sandbox do Mercado Pago
- Se o `application_fee` volta proporcionalmente numa devolução parcial/total (esperado para marketplace, mas confirme).
- Se a conta Mercado Pago da loja tem saldo para devolver (sem saldo o MP recusa e o erro aparece no painel da loja).
- Comportamento do webhook: pagamento totalmente devolvido vira "refunded" e o mapeamento atual o trata como Rechazado (já era assim).

## Testes
`npm test` roda os testes de OAuth e os novos (Firebase/Express/MP simulados, sem rede).
