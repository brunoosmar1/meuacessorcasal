# Meu Assessor (clone) — produto completo

Assistente financeiro + agenda via WhatsApp, no estilo do "Meu Assessor". Suporta
WhatsApp real (Meta Cloud API), Google Agenda, leitura de texto/imagem, contas a
pagar/receber, orçamentos, lembretes com notificação automática e painel web.

## Funcionalidades

**Financeiro**
- Registro de gastos e receitas por texto ("gastei 45 no mercado")
- Leitura de fotos de boleto/nota/comprovante (extração automática por IA com visão)
- Categorização automática
- Contas a pagar / a receber, com marcação de "já paguei" por linguagem natural
- Comando para desfazer o último lançamento ("desfaz esse gasto")
- Orçamento mensal por categoria com aviso ao estourar
- Resumo financeiro sob pedido (hoje / semana / mês)
- Painel web com totais, gráfico de gastos por categoria, contas pendentes

**Agenda / rotina**
- Lembretes por linguagem natural ("me lembra de X amanhã às 15h")
- Sincronização automática com o Google Agenda (se o usuário conectar a conta)
- Notificação automática no WhatsApp quando o horário do lembrete chega
- Aviso automático 1 dia antes do vencimento de contas

**Canal**
- Funciona simulado pelo navegador (`/`) para testes
- Funciona no WhatsApp real assim que a Cloud API for configurada — o mesmo motor
  de IA e banco de dados atende os dois canais, nada muda no código de negócio

## Como rodar localmente (modo simulado, sem WhatsApp real)

```bash
npm install
cp .env.example .env
# preencha pelo menos ANTHROPIC_API_KEY no .env
npm start
```

Abra `http://localhost:3000`. Aba **Chat** simula o WhatsApp, aba **Painel** mostra o dashboard.

## Como ativar o WhatsApp de verdade

1. Crie um app em https://developers.facebook.com/apps → adicione o produto **WhatsApp**.
2. No painel do produto WhatsApp, copie:
   - `Temporary access token` (ou gere um permanente com um System User) → `WHATSAPP_ACCESS_TOKEN`
   - `Phone number ID` → `WHATSAPP_PHONE_NUMBER_ID`
3. Escolha uma string secreta qualquer para `WHATSAPP_VERIFY_TOKEN` no `.env`.
4. Coloque o servidor no ar num endereço público (ver seção Deploy abaixo).
5. No painel do app Meta, configure o webhook apontando para:
   `https://SEU_DOMINIO/webhook/whatsapp`, usando o mesmo `WHATSAPP_VERIFY_TOKEN`.
6. Inscreva o campo `messages` no webhook.

A partir daí, mensagens reais de WhatsApp chegam em `POST /webhook/whatsapp`, são
interpretadas pela mesma IA e as respostas saem pelo número conectado.

## Como ativar o Google Agenda

1. Crie um projeto em https://console.cloud.google.com/ → ative a **Google Calendar API**.
2. Em "Credenciais", crie um **OAuth Client ID** do tipo "Aplicativo da Web".
3. Adicione a URI de redirecionamento: `http://localhost:3000/auth/google/callback`
   (troque pelo domínio real em produção).
4. Copie `Client ID` e `Client Secret` para o `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
5. No painel web (aba Painel), clique em **Conectar Google Agenda** — o usuário autoriza
   e, a partir daí, todo lembrete criado também vira evento no Google Agenda dele.

## Login e múltiplos usuários

O painel web agora tem login de verdade: a pessoa informa o telefone, recebe um
código de 6 dígitos por WhatsApp (ou vê o código na tela quando o WhatsApp real
ainda não está configurado — modo de teste) e entra com sessão própria. Cada
usuário só vê seus próprios dados; não existe mais um telefone fixo compartilhado.

Para virar administrador automaticamente, defina `ADMIN_PHONE` no `.env` com o seu
número (mesmo formato usado no login). Ao entrar com esse número pela primeira vez,
a conta já nasce como admin e ganha acesso a `/admin.html`, com métricas de uso:
usuários totais, ativos nos últimos 7/30 dias, volume financeiro do mês, conexões
com Google Agenda e bancos, e os usuários mais recentes.

## Compartilhar gastos entre duas pessoas (ex: casal)

Cada pessoa entra com seu próprio número de WhatsApp/login, mas os dois podem
compartilhar os mesmos gastos, contas a pagar e orçamentos — como se fosse uma
"conta de família". O que continua pessoal é a agenda (Google Calendar) e o
histórico de conversa de cada um.

**Como conectar as contas:**
1. Cada pessoa faz login normalmente (seu próprio número).
2. No painel, aba **Painel** → card **Família**, cada um vê seu próprio código de convite.
3. Uma pessoa pega o código da outra e cola no campo "Código de convite" → **Entrar**.
4. Pronto: a partir daí, os gastos, contas e orçamentos de ambos aparecem juntos
   para os dois. O histórico anterior de quem entrou por último também é migrado
   automaticamente — nada se perde.

**O que fica compartilhado:** lançamentos (gastos/receitas), contas a pagar/receber,
orçamentos por categoria (o limite vale para a soma dos dois).
**O que continua pessoal:** lembretes/agenda, conexão com Google Calendar, conexão
bancária (Open Finance) — cada um conecta a própria conta, mas as transações
importadas entram na base compartilhada.

No relatório (`"como estão nossas finanças?"`), quando há mais de uma pessoa na
família, aparece também uma quebra "por pessoa", mostrando quanto cada um gastou.

## Como ativar transcrição de áudio

O Claude não aceita áudio bruto como entrada. Escolha um provedor de transcrição
(ex: Whisper da OpenAI, Deepgram, Google Speech-to-Text), implemente a chamada dentro
de `transcribeAudio()` em `src/parser.js`, e informe a URL em `TRANSCRIPTION_PROVIDER_URL`
no `.env`. Sem isso, o assistente avisa o usuário e pede para escrever em texto.

## Como ativar Open Finance (conexão bancária automática)

Usa a [Pluggy](https://pluggy.ai) como agregador — ela fala com os bancos via Open
Finance e devolve as transações já estruturadas.

1. Crie uma conta em https://dashboard.pluggy.ai e pegue `Client ID` e `Client Secret`.
2. Coloque em `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` no `.env`.
3. No painel web (aba Painel), clique em **Conectar conta bancária** — abre o widget
   oficial da Pluggy, o usuário escolhe o banco e loga (em sandbox, dá pra testar sem
   dados reais).
4. Configure na Pluggy um webhook apontando para `https://SEU_DOMINIO/webhook/pluggy`
   para receber novas transações automaticamente conforme elas acontecem.

Sem essas variáveis configuradas, o botão do painel mostra um aviso claro ao usuário
em vez de quebrar.

## Testes automatizados

```bash
npm test
```

Cobre as regras de negócio principais (lançamentos, desfazer, orçamento estourado,
contas a pagar/receber, lembretes) e o módulo de login (código, sessão, promoção a
admin) usando o test runner nativo do Node — sem dependências extras. Roda
automaticamente a cada push via GitHub Actions (`.github/workflows/test.yml`).

## Segurança

- O webhook do WhatsApp valida a assinatura HMAC (`X-Hub-Signature-256`) das
  requisições usando o `WHATSAPP_APP_SECRET` do painel do app Meta, rejeitando
  qualquer chamada que não venha realmente da Meta. Em desenvolvimento local, deixe
  essa variável vazia para pular a validação.
- Tokens do Google (`google_tokens`) e da Pluggy nunca chegam ao front-end — ficam
  só no servidor.
- `/api/auth/request-code` aceita no máximo 5 pedidos por IP a cada 15 minutos, e
  `/api/auth/verify` no máximo 20 tentativas — protege contra spam de mensagens e
  força bruta no código de 6 dígitos.
- Sessões e códigos de login expirados são limpos automaticamente todo dia às 4h.

## Monitoramento

`GET /health` devolve um JSON simples (`{ ok, anthropicConfigured, whatsappConfigured }`)
para plataformas de deploy usarem como health check.

## Estrutura

```
src/
  db.js            → schema SQLite (households, users, transactions, bills, budgets,
                      reminders, google_tokens, open_finance_items, sessions, login_codes,
                      messages) + lógica de convite/entrada em família
  auth.js            → login por código via WhatsApp, sessões, middlewares requireAuth/requireAdmin
  adminMetrics.js    → métricas agregadas de uso para o painel administrativo
  parser.js         → IA: interpreta texto e imagens, transforma em intenção estruturada
  actions.js        → executa a intenção (grava no banco, calcula orçamento, monta resposta)
  whatsapp.js       → envio de mensagens e download de mídia via Meta Cloud API
  googleCalendar.js → OAuth2 e criação de eventos no Google Agenda
  openFinance.js     → conexão bancária e importação de transações via Pluggy
  scheduler.js      → cron: dispara lembretes na hora certa e avisa contas a vencer
  server.js         → rotas Express (webhooks, login, OAuth do Google, API do painel)
public/
  index.html         → interface (login + simulador de chat + painel financeiro)
  admin.html          → painel administrativo (métricas de uso, restrito a admins)
test/
  actions.test.js     → testes automatizados das regras de negócio
data/
  meuassessor.db      → banco SQLite (criado automaticamente)
Dockerfile / docker-compose.yml → deploy em qualquer serviço que rode containers
```

## Deploy em produção

**Opção mais simples — Docker:**
```bash
cp .env.example .env   # preencha as variáveis
docker compose up -d --build
```

**Ou manualmente**, em qualquer serviço que rode um processo Node.js persistente
(o cron do `scheduler.js` precisa de um processo sempre ativo):

- **Railway / Render / Fly.io**: aponte para este repositório, defina as variáveis
  de ambiente do `.env` no painel do serviço, comando de start `npm start`.
- **VPS própria**: `git clone`, `npm install`, configure `.env`, rode com `pm2` ou
  `systemd` para manter o processo vivo, e coloque um proxy reverso (nginx) com HTTPS
  na frente — a Meta exige que o webhook seja HTTPS.

## Próximos passos possíveis

- **Postgres em produção**: o schema em `db.js` é simples de portar do SQLite para
  Postgres quando o volume de usuários crescer (múltiplas instâncias do servidor).
- **Fila de mensagens**: para alto volume, mover o processamento do webhook para uma
  fila (ex: BullMQ + Redis) em vez de processar tudo de forma síncrona no handler.
- **Rate limiting no login**: limitar tentativas de `/api/auth/request-code` por IP
  para evitar spam de SMS/WhatsApp.
