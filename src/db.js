const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, "meuassessor.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  is_admin INTEGER DEFAULT 0,
  household_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS login_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('expense','income')),
  amount REAL NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('payable','receivable')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  due_date TEXT NOT NULL,
  paid INTEGER DEFAULT 0,
  notified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  monthly_limit REAL NOT NULL,
  UNIQUE(household_id, category),
  FOREIGN KEY(household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  google_event_id TEXT,
  notified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS google_tokens (
  user_id INTEGER PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expiry_date INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS open_finance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  institution TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS open_finance_synced_transactions (
  provider_transaction_id TEXT PRIMARY KEY,
  transaction_id INTEGER NOT NULL,
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Índices para as consultas mais frequentes (relatórios, listagens, autenticação)
CREATE INDEX IF NOT EXISTS idx_transactions_household_date ON transactions(household_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_household_type ON transactions(household_id, type);
CREATE INDEX IF NOT EXISTS idx_bills_household_paid ON bills(household_id, paid);
CREATE INDEX IF NOT EXISTS idx_budgets_household ON budgets(household_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user_done ON reminders(user_id, done);
CREATE INDEX IF NOT EXISTS idx_reminders_notify ON reminders(done, notified, remind_at);
CREATE INDEX IF NOT EXISTS idx_bills_notify ON bills(paid, notified, due_date);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id);
`);

function generateInviteCode() {
  // Código curto e fácil de digitar/compartilhar (ex: "7K9QX2AB")
  return crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, 8);
}

function createHousehold(name) {
  let code;
  // Garante unicidade do código (colisão é extremamente improvável, mas checamos mesmo assim)
  do {
    code = generateInviteCode();
  } while (db.prepare("SELECT 1 FROM households WHERE invite_code = ?").get(code));

  const info = db
    .prepare("INSERT INTO households (name, invite_code) VALUES (?, ?)")
    .run(name || null, code);
  return db.prepare("SELECT * FROM households WHERE id = ?").get(info.lastInsertRowid);
}

function getOrCreateUser(phone, name) {
  const existing = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (existing) return existing;

  const isAdmin = process.env.ADMIN_PHONE && phone === process.env.ADMIN_PHONE ? 1 : 0;
  // Cada usuário novo já nasce com sua própria "família" (household) — sozinho por padrão.
  // Ele pode entrar na família de outra pessoa depois usando um código de convite,
  // e nesse caso os lançamentos financeiros passam a ser compartilhados entre os dois.
  const household = createHousehold(name ? `Família de ${name}` : null);

  const info = db
    .prepare("INSERT INTO users (phone, name, is_admin, household_id) VALUES (?, ?, ?, ?)")
    .run(phone, name || null, isAdmin, household.id);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

function getHouseholdMembers(householdId) {
  return db.prepare(`SELECT id, name, phone FROM users WHERE household_id = ? ORDER BY id ASC`).all(householdId);
}

function getHouseholdByInviteCode(code) {
  return db.prepare(`SELECT * FROM households WHERE invite_code = ?`).get(code);
}

// Move o usuário para a família de outra pessoa (usando o código de convite dela)
// e migra o histórico financeiro dele (lançamentos, contas, orçamentos) para lá,
// para que nada se perca e passe a ser compartilhado com os outros membros.
function joinHousehold(userId, inviteCode) {
  const targetHousehold = getHouseholdByInviteCode(inviteCode);
  if (!targetHousehold) return { ok: false, error: "Código de convite inválido." };

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) return { ok: false, error: "Usuário não encontrado." };
  if (user.household_id === targetHousehold.id) {
    return { ok: false, error: "Vocês já estão na mesma família." };
  }

  const oldHouseholdId = user.household_id;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE transactions SET household_id = ? WHERE household_id = ?`).run(targetHousehold.id, oldHouseholdId);
    db.prepare(`UPDATE bills SET household_id = ? WHERE household_id = ?`).run(targetHousehold.id, oldHouseholdId);
    // Orçamentos têm limite único por categoria dentro da família — se já existir
    // um orçamento igual na família de destino, mantemos o da família de destino
    // e descartamos o antigo para não duplicar/colidir.
    const oldBudgets = db.prepare(`SELECT * FROM budgets WHERE household_id = ?`).all(oldHouseholdId);
    for (const b of oldBudgets) {
      const conflict = db
        .prepare(`SELECT 1 FROM budgets WHERE household_id = ? AND category = ?`)
        .get(targetHousehold.id, b.category);
      if (!conflict) {
        db.prepare(`UPDATE budgets SET household_id = ? WHERE id = ?`).run(targetHousehold.id, b.id);
      }
    }
    db.prepare(`DELETE FROM budgets WHERE household_id = ?`).run(oldHouseholdId);
    db.prepare(`UPDATE users SET household_id = ? WHERE id = ?`).run(targetHousehold.id, userId);
    db.prepare(`DELETE FROM households WHERE id = ?`).run(oldHouseholdId);
  });
  tx();

  return { ok: true, household: targetHousehold };
}

function cleanupExpired() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  db.prepare(`DELETE FROM login_codes WHERE expires_at < ?`).run(Date.now());
}

module.exports = {
  db,
  getOrCreateUser,
  cleanupExpired,
  getHouseholdMembers,
  getHouseholdByInviteCode,
  joinHousehold,
};
