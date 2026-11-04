# NotPush V7.6.0 — ofertas automáticas (café, almoço e jantar)

## O que muda
- **Rota nova `POST /cron/ofertas`.** Ela não usa login: só aceita quem manda o cabeçalho `X-Push-Cron-Chave` com a chave certa (`PUSH_CRON_CHAVE`). O cron-job.org chama essa rota a cada 15 min.
- O Master liga e desliga em **Marketing → Notificações automáticas**, que grava em `config_plataforma/push_auto`. Sem essa configuração, nada sai.
- **Cada horário** (café, almoço e jantar) sai **no máximo 1 vez por dia**, no dia da semana marcado, entre a hora escolhida e 29 min depois. O cron chama a cada 15 min, então cada horário tem 2 chances.
- **O que vai em cada horário:**
  1. **Mensagem fixa**, se o Master escolheu esse modo: título e texto do Master; ao tocar, abre a loja escolhida ou a tela inicial.
  2. **Oferta automática**, no modo padrão:
     - **Anúncio primeiro.** No almoço ou no jantar, sai primeiro o anúncio no ar que ainda tem notificação incluída no plano. O que termina antes vai primeiro, e sai **no máximo 1 anúncio por dia** na plataforma. O texto da notificação é a frase do banner que já foi aprovada.
     - **Senão, um cupom.** O cupom é público e válido hoje, de uma loja **aberta nesse horário** (mesma regra do app: horário de Brasília, abertura adiada, loja suspensa e cidade em espera). As lojas entram em **revezamento**: vai primeiro a que apareceu há mais tempo (`push_auto_lojas`).
     - Não entram cupons secretos, esgotados ou vencidos. O de 1ª compra só entra quando a loja não tem outro.
     - Se nenhuma loja serve, **não envia**: registra "sem oferta" e tenta de novo depois de 10 min, ainda dentro da janela.
- **Texto da notificação:** "🍽️ Oferta da Uai Crep's" e "10% OFF em pedidos acima de R$ 30. Toque para pedir no almoço." Ao tocar, abre a loja com o cupom já guardado (`restaurante.html?id=…&cupom=…`).
- **Quem recebe:** todos os aparelhos com notificação ativada, **menos** quem desligou "Ofertas e cupons" no perfil (`prefs_ofertas/{uid}` = false) e as contas bloqueadas. Os avisos do pedido continuam chegando para todos.
- **A campanha manual do Master** (`/notificar-master`) e **o aviso de cupom da loja** (`/notificar-cupom`) também deixam de fora quem desligou "Ofertas e cupons".
- **Notificações dos planos de anúncio:** o Master define quantas vêm em cada plano em `config_plataforma/anuncios_planos`, nos campos n7, n15 e n30, de 0 a 10. No 1º envio, o total do anúncio fica **congelado** em `anuncios_push/{anuncioId}` com {total, usados, lojaId, envios}. Se o Master mudar o plano depois, quem já comprou não perde nada.
- **O que fica gravado para o Master e a loja verem:**
  - `push_publico`: aparelhos e clientes que aceitam ofertas;
  - `push_auto_status`: última chamada, versão e último resultado. É assim que o Master vê "Agendador funcionando";
  - `notificaciones_auto/{dia}/{horario}`: o que saiu, para quantos aparelhos, ou por que não saiu;
  - `notificaciones_auto_ad/{dia}`: o anúncio do dia.
- Aparelho que não existe mais sai da lista, como já acontecia nos outros envios.

## Arquivos alterados
- `notificacoes.js`: regras puras (relógio de Brasília, horários, loja aberta, cidade, cupons, anúncio, texto e público).
- `serve.js`: rota `/cron/ofertas`, envio em massa, filtro "Ofertas e cupons" no Master e no cupom, `VERSAO` 7.6.0.
- `tests/ofertas.test.cjs` (novo), `package.json` 7.6.0 (o teste novo entra no `npm test`).
- `.env.example` e `README.md`.

## Variável nova no Render (serviço do NotPush)
- `PUSH_CRON_CHAVE`: uma chave **nova**, com pelo menos 16 caracteres. Use a mesma no cabeçalho do cron-job.org. Ela não vai no site nem no GitHub. Sem ela, a rota responde 401 e nada sai.

## Publicar
- Junto com o site **V75.245**, que tem a tela do Master, o plano com notificações, o painel da loja e a chave no perfil.
- Junto com as regras **V75.245**.
