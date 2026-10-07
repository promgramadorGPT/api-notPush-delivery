# NotPush Delivery V7 — avisos push do YAPOOD

Rotas (todas com Firebase ID Token, exceto `/` e `/health`):
- `POST /registrar-token` {token, plataforma?} — grava o aparelho do usuário. Um aparelho pertence a uma conta só (se outra conta usou antes, sai da anterior) e cada usuário guarda no máximo 10.
- `POST /remover-token` {token}
- `POST /notificar-pedido` {pedidoKey, evento} — ou {evento:'bairro', lojaId, bairroId}.
- `POST /notificar-master` {titulo, corpo, link?, campanhaId?} — só Master.
- `GET /health`

## Eventos
| evento | quem dispara | quem recebe | abre |
|---|---|---|---|
| `novo` | cliente do pedido | dono da loja | admin-loja.html |
| `aceito` (ou `aceptado`) | dono da loja | cliente | status.html?num=… |
| `despachado` (ou `enviado`) | dono da loja | cliente | status.html?num=… |
| `entregue` | entregador da entrega ou dono (entrega já concluída) | cliente | status.html?num=… |
| `atribuido` | dono da loja | entregador atribuído (ativo, da mesma loja) | entregador.html |
| `bairro` | cliente que sugeriu o bairro | dono da loja | admin-loja.html |

O servidor confere tudo no banco (quem é o dono, o cliente e o entregador); o app só diz qual evento aconteceu.

## Testes
`npm test` — roda sem rede, com Firebase e FCM simulados.
