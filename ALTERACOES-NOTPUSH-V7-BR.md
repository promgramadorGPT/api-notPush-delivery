# NotPush Delivery V7 — BR (candidata, não publicada)

Base: V6 BR (a que você enviou). Rotas, autenticação (Firebase ID Token), caminhos já gravados e as variáveis do Render foram mantidos. `server.js` (vazio) foi removido; o arquivo de entrada continua `serve.js`.

## Novidades
- **Eventos novos:** `atribuido` (aviso ao entregador quando a loja atribui uma entrega — chega mesmo com o app fechado), `entregue` (aviso ao cliente quando o entregador confirma o código) e `bairro` (aviso ao dono quando um cliente pede em bairro ainda não cadastrado).
- **Links certos:** cada aviso abre a tela do assunto (pedido do cliente, painel da loja, painel do entregador). Antes todos abriam a raiz e o `link` que o service worker lia nem era enviado. O link só é enviado se `APP_URL` for https (o FCM recusa o resto).
- **Sem aviso em dobro:** o aviso leva uma `tag` por pedido+evento; Firebase e service worker passam a substituir um ao outro.
- **Prioridade alta** (`Urgency: high`, validade de 1 h) nos avisos de pedido e entrega.

## Correções
- **Duplicidade em chamadas simultâneas:** a checagem “já enviei?” era leitura e depois escrita; dois cliques ao mesmo tempo enviavam duas vezes. Agora há reserva por transação (60 s).
- **Aparelho compartilhado entre contas:** se A saía e B entrava no mesmo celular, os avisos de A continuavam chegando para B. Novo índice `fcm_token_owner/{hash}` tira o aparelho da conta anterior ao registrar na nova. Aparelhos registrados antes da V7 só entram no índice quando reabrirem o app logados.
- **Limites:** no máximo 10 aparelhos por usuário (saem os mais antigos), token validado, até 40 chamadas por minuto por usuário, corpo da requisição limitado a 20 KB.
- **Erros internos** não mostram mais a mensagem técnica ao app (continuam no log).
- **Envio em paralelo** (antes um aparelho por vez, com até 20 s de espera cada).
- **Master:** título/mensagem com tamanho máximo, link validado (só https ou caminho do app), mesmo aparelho não recebe duas vezes.
- `.env.example` apontava para o banco de outro projeto; agora é o `yapoodbr-delivery`.

## Variáveis no Render
Sem novas. Confirme: `APP_URL` (https), `ALLOWED_ORIGINS` (o domínio do app), `EXPECTED_PROJECT_ID=yapoodbr-delivery`.

## Testes
`npm test`: 10 etapas, sem rede (Firebase e FCM simulados). **Não testado com o FCM real** — teste primeiro em um serviço separado no Render.

## Publicar
1. Subir esta API (pode antes do front: os eventos novos só passam a ser usados pelo front V75.24).
2. Publicar o front V75.24.
3. Nos celulares: abrir o app do entregador, permitir notificações e fazer uma atribuição de teste.
