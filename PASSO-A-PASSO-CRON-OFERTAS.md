# Passo a passo: ofertas automáticas (NotPush 7.6 + cron-job.org)

## Ordem de publicação

### 1. Regras do Firebase
No Console do Firebase, abra **Realtime Database → Regras**. Cole o arquivo `regras/database.rules.RASCUNHO-V75.245.json` do site e clique em **Publicar**.

### 2. NotPush 7.6.0 no GitHub
Suba os arquivos do zip `notpush-V7_6_0.zip` no repositório da NotPush, substituindo os antigos. O Render faz o deploy sozinho.

### 3. Chave nova no Render
1. Crie uma chave **nova**, só para isso, sem reaproveitar outra. Ela precisa ter pelo menos 16 caracteres, só com letras e números. Um gerador de senhas serve; anote a chave num lugar seguro.
2. No Render, abra o serviço **api-notpush-delivery**, depois **Environment** e **Add Environment Variable**:
   - Key: `PUSH_CRON_CHAVE`
   - Value: a chave que você criou
3. Clique em **Save Changes**. O serviço reinicia.
4. A chave **não vai** no site, no GitHub nem no chat.

### 4. Site V75.245 no Cloudflare Pages
Suba o zip `subir-cloudflare-pages`.

### 5. Tarefa nova no cron-job.org
Use a mesma conta de sempre, mas crie uma tarefa **nova**. Não mexa na tarefa do acerto.
1. Clique em **Create cronjob**.
2. **Title:** `YaPOOD ofertas automáticas`
3. **URL:** `https://api-notpush-delivery.onrender.com/cron/ofertas`
4. **Execution schedule:** **Every 15 minutes**.
5. Na aba **Advanced**:
   - **Request method:** `POST`
   - **Headers**, clique em **Add**:
     - `X-Push-Cron-Chave` = a mesma chave do Render;
     - `Content-Type` = `application/json`.
   - **Request body:** `{}`
   - **Timeout:** o maior que o plano permitir (30 s).
6. Em **Notifications**, marque o aviso por e-mail quando a tarefa falhar.
7. Clique em **Create**. Depois use **Test run**. A resposta certa é **200**, com `{"ok":true,"ativo":false,...}` enquanto o Master estiver desligado.
   - **401:** a chave do cabeçalho está diferente da do Render, ou o Render ainda não reiniciou.
   - **Tempo esgotado na 1ª vez:** é normal no Render grátis, que estava dormindo. A chamada seguinte, 15 min depois, funciona. Cada horário tem 30 min de janela, ou seja, 2 chances.

### 6. Ligar no Master
1. Abra **Marketing → Notificações automáticas**. Confira se o card mostra "Agendador funcionando · última chamada há X min".
2. Ligue a **chave geral** e os horários que quiser. Confira os dias da semana e clique em **Salvar notificações automáticas**.
3. Em **Planos de anúncio**, preencha **Notificações incluídas** (sugestão: 1, 2 e 4) e salve.

## Como saber se está funcionando
- **No Master, "Últimos envios":** cada horário mostra para quantos aparelhos saiu, ou por que não saiu. Por exemplo, "nenhuma loja aberta com cupom".
- **No Render, em Logs:** as linhas `OFERTA AUTO: …`.
- **Para testar sem esperar o almoço:** use um horário que ainda não saiu hoje e ponha a hora, por exemplo, 5 min à frente, com só o dia de hoje marcado, e salve. A próxima chamada do cron, que acontece a cada 15 min, envia o aviso dentro da janela de 30 min. Depois volte o horário ao normal. Atenção: o teste sai de verdade para todos os clientes que aceitam ofertas; prefira a "Mensagem fixa" com um texto que sirva para o público.
