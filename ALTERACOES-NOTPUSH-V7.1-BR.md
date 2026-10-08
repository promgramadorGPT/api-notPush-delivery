# NotPush V7.1 — aviso automático de cupom

Nova rota `POST /notificar-cupom` `{ lojaId, cupomId }` (autenticada com o ID Token do Firebase). Nenhuma variável de ambiente nova.

Conferido no servidor, nesta ordem:
1. Quem chama é o **dono da loja** (`restaurantes/{lojaId}/ownerUid`).
2. Loja ativa e **não suspensa** pelo Master.
3. Cupom existe e está **ativo** (porcentagem 1–100, valor fixo > 0 ou entrega grátis, código válido).
4. Chave do Master `config_plataforma/push_cupom.ativo` (padrão: ligado).
5. **1 cupom avisado por dia por loja** (dia de Brasília) e **cada cupom só é avisado uma vez**. As duas reservas são transações, então chamadas simultâneas não enviam em dobro.
6. Público: clientes **distintos que já pediram na loja** (últimos 2000 pedidos), sem contas em `usuarios_bloqueados`.
7. **Teto diário da plataforma** (`push_cupom.limiteDiario`, padrão 5000 aparelhos): passou do teto, o envio é cortado.

Se não houver ninguém com aparelho cadastrado, ou o teto estourar, a reserva é liberada e a loja pode tentar de novo.

Texto fixo: `🎟️ Cupom CODIGO — Loja` / `10% de desconto em pedidos a partir de R$ 30,00. Toque para aproveitar.` Abre `restaurante.html?id=LOJA`.

Registros gravados (só pelo servidor): `notificaciones_cupons/{lojaId}/{cupomId}`, `notificaciones_cupons_dia/{dia}/{lojaId}`, `notificaciones_cupons_total/{dia}`.

Testes: `npm test` (novas seções 1b e 9b).
