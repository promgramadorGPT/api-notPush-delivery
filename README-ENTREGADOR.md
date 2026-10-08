# V2.3 — Entregador e código de entrega
Rotas (todas POST, Firebase ID Token):
- `/entregador/convidar` {lojaId,email,nome,taxa} — dono da loja.
- `/entregador/entrar` — primeiro acesso do entregador (casa o e-mail verificado do Google com o convite).
- `/entregador/atribuir` {lojaId,pedidoKey,entregadorUid,taxa?} — dono da loja.
- `/entregador/minhas` — só as entregas do próprio entregador (sem código).
- `/entrega/meu-codigo` {pedidoKey} — só o cliente dono do pedido.
- `/entregador/validar-codigo` {pedidoKey,codigo} — máx. 5 tentativas; se correto grava `entregaConfirmada`, marca o pedido como entregue e registra a taxa.

Nós novos (só servidor): `entregadores`, `entregadores_convites`, `entregas`, `entregas_por_entregador`, `taxas_entregador`.
O código é derivado de `PIN_SECRET` + pedidoKey (HMAC); não é gravado. Não troque o `PIN_SECRET` depois de publicar.

## V2.4 — rotas do dono da loja (POST, Firebase ID Token do dono)
- `/entregador/listar` {lojaId} — entregadores e convites pendentes.
- `/entregador/taxas` {lojaId} — taxas registradas dos entregadores da loja.
- `/entregador/pagar-taxa` {lojaId,entregadorUid,pedidoKey} — marca a taxa como paga.
- `/entregador/ativar` {lojaId,entregadorUid,ativo} — ativa ou desativa o entregador.

## V2.6 — gestão completa (todas POST, Firebase ID Token)
Dono da loja:
- `/entregador/convidar` agora aceita `telefone` e recusa e-mail já cadastrado (409).
- `/entregador/editar` {lojaId,entregadorUid,nome?,taxaPadrao?,telefone?}.
- `/entregador/cancelar-convite` {lojaId,email}.
- `/entregador/entregas` {lojaId} — entregas atribuídas da loja (**rota que faltava desde a V2.4**; sem ela a aba Entregas do ADM ficava vazia).
- `/entregador/desatribuir` {lojaId,pedidoKey} — só entrega ainda não confirmada.
- `/entregador/pagar-lote` {lojaId,entregadorUid,forma:'pix'|'dinheiro'|'outro',obs?,pedidoKeys?} — paga várias taxas de uma vez (máx. 100). Cada taxa é reservada por transação, então clique duplo ou duas abas não pagam duas vezes. Grava o comprovante em `acertos_entregador/{uid}/{id}`.
- `/entregador/acertos` {lojaId,entregadorUid?} — histórico de pagamentos.
- `/entregador/taxas` passou a devolver `pagoEm` e `acertoId`.

Entregador:
- `/entregador/minhas` devolve também `loja{nome,telefone}`, `bairro` e `tentativasRestantes` por entrega, `pagoEm/acertoId` nas taxas e `acertos` (pagamentos recebidos).
- `/entregador/validar-codigo` devolve `restantes` nos erros 403/429.

Nó novo (só servidor): `acertos_entregador`. Sem mudança de variáveis de ambiente.
