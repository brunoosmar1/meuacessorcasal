const crypto = require("crypto");
const { db, getOrCreateUser } = require("./db");
const whatsapp = require("./whatsapp");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

// Gera um código de 6 dígitos e envia por WhatsApp (ou loga no console se o
// WhatsApp real não estiver configurado, útil para testar em desenvolvimento).
async function requestLoginCode(phone, name) {
  const user = getOrCreateUser(phone, name);
  const code = generateCode();
  const expiresAt = Date.now() + CODE_TTL_MS;

  db.prepare(
    `INSERT INTO login_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`
  ).run(phone, code, expiresAt);

  await whatsapp.sendText(phone, `Seu código de acesso ao Meu Assessor é: ${code}\nVale por 10 minutos.`);
  return { sent: true, simulated: !whatsapp.configured(), devCode: whatsapp.configured() ? undefined : code };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  return { token, expiresAt };
}

function verifyLoginCode(phone, code) {
  const row = db.prepare(`SELECT * FROM login_codes WHERE phone = ?`).get(phone);
  if (!row) return { ok: false, error: "Nenhum código pendente para esse número. Peça um novo." };
  if (Date.now() > row.expires_at) return { ok: false, error: "Código expirado. Peça um novo." };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "Muitas tentativas erradas. Peça um novo código." };

  if (row.code !== String(code)) {
    db.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE phone = ?`).run(phone);
    return { ok: false, error: "Código incorreto." };
  }

  db.prepare(`DELETE FROM login_codes WHERE phone = ?`).run(phone);
  const user = getOrCreateUser(phone);
  const session = createSession(user.id);
  return { ok: true, token: session.token, user };
}

function getUserBySession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, Date.now());
  return row || null;
}

function destroySession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// Middleware Express: exige sessão válida (cookie "session") e injeta req.user.
function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const user = getUserBySession(token);
  if (!user) return res.status(401).json({ error: "Não autenticado. Faça login novamente." });
  req.user = user;
  next();
}

// Middleware Express: exige sessão válida E que o usuário seja admin.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: "Acesso restrito a administradores." });
    next();
  });
}

module.exports = {
  requestLoginCode,
  verifyLoginCode,
  getUserBySession,
  destroySession,
  requireAuth,
  requireAdmin,
};
