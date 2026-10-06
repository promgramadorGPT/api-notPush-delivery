# NotPush Delivery V6 — BR (candidata, não publicada)

Base: api-notpush-delivery-v5-master-notificacoes.zip. Rotas, autenticação (Firebase ID Token) e caminhos no Firebase foram mantidos.

## Mudanças
- Mensagens ao ADM e ao cliente em PT-BR (antes em espanhol).
- Eventos: aceita os nomes atuais do app (`novo`, `aceptado`, `despachado`) e também `aceito` e `enviado`. As chaves gravadas em `notificaciones_pedidos` continuam as mesmas.
- Origem permitida: variável `ALLOWED_ORIGINS` (lista separada por vírgula, ex.: `https://seu-dominio.com`). Sem a variável, tudo continua aceito e o log avisa.
- Projeto Firebase: variável `EXPECTED_PROJECT_ID` (use `yapoodbr-delivery`). Se a chave de serviço for de outro projeto, o Firebase não inicia.
- O mesmo evento do mesmo pedido não é enviado duas vezes se já foi entregue a algum aparelho.

## Variáveis no Render
FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_DATABASE_URL, APP_URL, ALLOWED_ORIGINS (nova), EXPECTED_PROJECT_ID (nova).

## Não testado
Sem acesso à rede neste ambiente: só a sintaxe foi verificada (`node --check`). Teste primeiro em um serviço separado no Render antes de trocar o atual.
