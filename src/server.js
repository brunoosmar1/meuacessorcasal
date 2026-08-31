require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { db, getOrCreateUser, cleanupExpired, getHouseholdMembers, joinHousehold } = require("./db");
const { interpretMessage, interpretImageMessage, transcribeAudio } = require("./parser");
const { executeIntent } = require("./actions");
const whatsapp = require("./whatsapp");
const googleCalendar = require("./googleCalendar");
const openFinance = require("./openFinance");
const scheduler = require("./scheduler");
const auth = require("./auth");
const adminMetrics = require("./adminMetrics");

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // guardamos o corpo cru para validar a assinatura do webhook da Meta
    },
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

function isValidMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // sem app secret configurado, pula a validação (modo dev)
  const signature = req.get("x-hub-signature-256");
  if (!signature) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Limita pedidos de código por IP: evita que alguém use o endpoint para
// bombardear um número de WhatsApp de terceiros com mensagens de "código de acesso".
const requestCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitos pedidos de código. Aguarde alguns minutos e tente novamente." },
});

// Limita tentativas de verificação por IP: dificulta força bruta no código de 6 dígitos.
const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
});

async function processTextForUser(user, text) {
  db.prepare(`INSERT INTO messages (user_id, direction, content) VALUES (?, 'in', ?)`).run(user.id, text);
  if (!process.env.ANTHROPIC_API_KEY) {
    return "⚠️ ANTHROPIC_API_KEY não configurada no servidor.";
  }
  const parsed = await interpretMessage(text, todayISO());
  const reply = await executeIntent(user, parsed, todayISO());
  db.prepare(`INSERT INTO messages (user_id, direction, content) VALUES (?, 'out', ?)`).run(user.id, reply);
  return reply;
}

async function processImageForUser(user, base64Data, mimeType, caption) {
  db.prepare(`INSERT INTO messages (user_id, direction, content) VALUES (?, 'in', ?)`).run(
    user.id,
    caption ? `[imagem] ${caption}` : "[imagem enviada]"
  );
  const parsed = await interpretImageMessage(base64Data, mimeType, todayISO(), caption);
  const reply = await executeIntent(user, parsed, todayISO());
  db.prepare(`INSERT INTO messages (user_id, direction, content) VALUES (?, 'out', ?)`).run(user.id, reply);
  return reply;
}

// ---------- Health check (para plataformas de deploy) ----------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    whatsappConfigured: whatsapp.configured(),
  });
});

// ---------- Login (código de 6 dígitos enviado por WhatsApp) ----------

app.post("/api/auth/request-code", requestCodeLimiter, async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
    const result = await auth.requestLoginCode(phone, name);
    // Em modo simulado (sem WhatsApp Cloud API configurado), devolvemos o código
    // na resposta só para testes locais — isso NUNCA deve acontecer em produção real.
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gerar código de acesso" });
  }
});

app.post("/api/auth/verify", verifyCodeLimiter, (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: "phone e code são obrigatórios" });
  const result = auth.verifyLoginCode(phone, code);
  if (!result.ok) return res.status(401).json({ error: result.error });

  res.cookie("session", result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, user: { name: result.user.name, phone: result.user.phone } });
});

app.post("/api/auth/logout", (req, res) => {
  if (req.cookies?.session) auth.destroySession(req.cookies.session);
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ name: req.user.name, phone: req.user.phone, isAdmin: Boolean(req.user.is_admin) });
});

// ---------- Chat e painel do usuário logado ----------

app.post("/api/chat", auth.requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text é obrigatório" });
    const reply = await processTextForUser(req.user, text);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno", details: err.message });
  }
});

app.get("/api/history", auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT direction, content, created_at FROM messages WHERE user_id = ? ORDER BY id ASC`)
    .all(req.user.id);
  res.json(rows);
});

app.get("/api/summary", auth.requireAuth, (req, res) => {
  const user = req.user;
  const month = todayISO().slice(0, 7);

  const byCategory = db
    .prepare(
      `SELECT category, SUM(amount) as total FROM transactions
       WHERE household_id = ? AND type = 'expense' AND occurred_at LIKE ?
       GROUP BY category ORDER BY total DESC`
    )
    .all(user.household_id, `${month}%`);

  const totals = db
    .prepare(
      `SELECT type, COALESCE(SUM(amount),0) as total FROM transactions
       WHERE household_id = ? AND occurred_at LIKE ? GROUP BY type`
    )
    .all(user.household_id, `${month}%`);

  const bills = db
    .prepare(
      `SELECT b.*, u.name as user_name FROM bills b JOIN users u ON u.id = b.user_id
       WHERE b.household_id = ? AND b.paid = 0 ORDER BY b.due_date ASC`
    )
    .all(user.household_id);
  const reminders = db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND done = 0 ORDER BY remind_at ASC`).all(user.id);
  const budgets = db.prepare(`SELECT * FROM budgets WHERE household_id = ?`).all(user.household_id);
  const googleConnected = googleCalendar.isConnected(user.id);
  const openFinanceConnected = openFinance.isConnected(user.id);

  const recentByPerson = db
    .prepare(
      `SELECT t.amount, t.category, t.type, t.description, t.occurred_at, u.name as user_name, u.phone as user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.household_id = ? ORDER BY t.id DESC LIMIT 15`
    )
    .all(user.household_id);

  res.json({ byCategory, totals, bills, reminders, budgets, googleConnected, openFinanceConnected, recentByPerson });
});

// ---------- Família (household): convidar e ver membros ----------

app.get("/api/household/me", auth.requireAuth, (req, res) => {
  const household = db.prepare(`SELECT * FROM households WHERE id = ?`).get(req.user.household_id);
  const members = getHouseholdMembers(req.user.household_id);
  res.json({
    inviteCode: household.invite_code,
    members: members.map((m) => ({ name: m.name, phone: m.phone, isYou: m.id === req.user.id })),
  });
});

app.post("/api/household/join", auth.requireAuth, (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: "Código de convite é obrigatório." });
  const result = joinHousehold(req.user.id, inviteCode.trim().toUpperCase());
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---------- Open Finance (Pluggy): conectar conta bancária ----------

app.post("/api/open-finance/connect-token", auth.requireAuth, async (req, res) => {
  try {
    if (!openFinance.configured()) {
      return res.status(400).json({ error: "Open Finance não configurado no servidor (PLUGGY_CLIENT_ID/SECRET ausentes)." });
    }
    const accessToken = await openFinance.createConnectToken(req.user.id);
    res.json({ accessToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Chamado pelo front depois que o usuário termina o fluxo de conexão no widget da Pluggy.
app.post("/api/open-finance/link", auth.requireAuth, async (req, res) => {
  try {
    const { itemId, institution } = req.body;
    openFinance.saveItem(req.user.id, itemId, institution);
    const imported = await openFinance.syncItemTransactions(itemId, req.user.id);
    res.json({ ok: true, imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook da Pluggy: dispara quando novas transações estão prontas para um item.
app.post("/webhook/pluggy", async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, itemId, clientUserId } = req.body;
    if (event === "transactions/updated" && itemId && clientUserId) {
      await openFinance.syncItemTransactions(itemId, Number(clientUserId));
    }
  } catch (err) {
    console.error("Erro processando webhook da Pluggy:", err);
  }
});

// ---------- Painel administrativo ----------

app.get("/api/admin/metrics", auth.requireAdmin, (req, res) => {
  res.json(adminMetrics.getMetrics());
});

// ---------- Google Agenda: conectar conta ----------

app.get("/auth/google/start", auth.requireAuth, (req, res) => {
  res.redirect(googleCalendar.getAuthUrl(req.user.id));
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    await googleCalendar.handleOAuthCallback(code, Number(state));
    res.send("✅ Google Agenda conectada! Você já pode fechar esta janela e voltar ao chat.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao conectar Google Agenda: " + err.message);
  }
});

// ---------- Webhook real do WhatsApp (Meta Cloud API) ----------

// Verificação exigida pela Meta ao configurar o webhook no painel do app.
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Recebimento de mensagens reais do WhatsApp.
app.post("/webhook/whatsapp", async (req, res) => {
  if (!isValidMetaSignature(req)) {
    console.warn("Webhook do WhatsApp recebido com assinatura inválida — ignorado.");
    return res.sendStatus(403);
  }
  res.sendStatus(200); // responde rápido pra Meta não reenviar o mesmo evento

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const contactName = change.value.contacts?.[0]?.profile?.name;
    const user = getOrCreateUser(from, contactName);

    if (message.type === "text") {
      const reply = await processTextForUser(user, message.text.body);
      await whatsapp.sendText(from, reply);
    } else if (message.type === "image") {
      const { buffer, mimeType } = await whatsapp.downloadMedia(message.image.id);
      const reply = await processImageForUser(user, buffer.toString("base64"), mimeType, message.image.caption);
      await whatsapp.sendText(from, reply);
    } else if (message.type === "audio") {
      const { buffer, mimeType } = await whatsapp.downloadMedia(message.audio.id);
      const text = await transcribeAudio(buffer, mimeType);
      if (!text) {
        await whatsapp.sendText(
          from,
          "Recebi seu áudio, mas a transcrição de voz ainda não está configurada neste servidor. Pode escrever em texto por enquanto?"
        );
        return;
      }
      const reply = await processTextForUser(user, text);
      await whatsapp.sendText(from, reply);
    } else {
      await whatsapp.sendText(from, "Por enquanto eu entendo texto, foto de boleto/comprovante e áudio.");
    }
  } catch (err) {
    console.error("Erro processando webhook do WhatsApp:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Meu Assessor (clone) rodando em http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("⚠️  ANTHROPIC_API_KEY não definida. Copie .env.example para .env e preencha.");
  }
  if (!whatsapp.configured()) {
    console.log("ℹ️  WhatsApp Cloud API não configurada — mensagens de saída reais serão apenas logadas (modo simulado).");
  }
  scheduler.start();
});
