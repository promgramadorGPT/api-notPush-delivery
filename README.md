# notpush-delivery v3 — diagnóstico FCM

Substitua `serve.js` e `package.json` no repositório usado pelo Render.

Esta versão mantém:
- POST /registrar-token
- POST /remover-token
- POST /notificar-pedido
- GET /health

A diferença principal é o envio FCM individual com `admin.messaging().send()` e logs explícitos:
- Enviando FCM...
- FCM OK...
- FCM ERRO...
- RESULTADO FINAL...

Também há timeout de 20 segundos por token para que um travamento do envio não fique silencioso.

Mantenha no Render as variáveis de ambiente já existentes.
