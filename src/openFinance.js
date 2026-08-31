// Integração Open Finance via Pluggy (https://pluggy.ai).
// Pluggy é um agregador que fala com os bancos via Open Finance e devolve as
// transações já estruturadas — evita ter que integrar banco por banco na mão.
//
// Fluxo:
// 1. Backend pede um "connect token" pra Pluggy (client_id/secret ficam só no servidor)
// 2. Front abre o widget de conexão da Pluggy usando esse token (usuário loga no banco dele)
// 3. Pluggy cria um "item" e manda um webhook quando as transações estão prontas
// 4. Buscamos as transações do item e gravamos como despesas/receitas, evitando duplicar

const { db } = require("./db");

const PLUGGY_BASE = "https://api.pluggy.ai";
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

let cachedApiKey = null;
let cachedApiKeyExpiry = 0;

// Autentica o backend na Pluggy (não confundir com o token do usuário final).
async function getApiKey() {
  if (cachedApiKey && Date.now() < cachedApiKeyExpiry) return cachedApiKey;
  const res = await fetch(`${PLUGGY_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error("Falha ao autenticar na Pluggy: " + (await res.text()));
  const data = await res.json();
  cachedApiKey = data.apiKey;
  cachedApiKeyExpiry = Date.now() + 100 * 60 * 1000; // válido ~2h, renova a cada 100min
  return cachedApiKey;
}

// Gera um token de conexão de curta duração pra usar no widget do front-end.
// userId vira o "clientUserId" na Pluggy, pra vincularmos o item ao usuário certo depois.
async function createConnectToken(userId) {
  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE}/connect_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ clientUserId: String(userId) }),
  });
  if (!res.ok) throw new Error("Falha ao criar connect token: " + (await res.text()));
  const data = await res.json();
  return data.accessToken;
}

function saveItem(userId, itemId, institution) {
  db.prepare(
    `INSERT INTO open_finance_items (user_id, item_id, institution) VALUES (?, ?, ?)`
  ).run(userId, itemId, institution || null);
}

function isConnected(userId) {
  const row = db
    .prepare(`SELECT 1 FROM open_finance_items WHERE user_id = ? AND status = 'active'`)
    .get(userId);
  return Boolean(row);
}

// Busca as transações de um item na Pluggy e grava as novas no nosso banco,
// evitando duplicar quando o webhook disparar mais de uma vez para o mesmo item.
async function syncItemTransactions(itemId, userId) {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) throw new Error("Usuário não encontrado para sincronizar transações.");

  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE}/transactions?accountId=${itemId}&pageSize=200`, {
    headers: { "X-API-KEY": apiKey },
  });
  if (!res.ok) throw new Error("Falha ao buscar transações: " + (await res.text()));
  const data = await res.json();

  const insertSynced = db.prepare(
    `INSERT OR IGNORE INTO open_finance_synced_transactions (provider_transaction_id, transaction_id) VALUES (?, ?)`
  );
  const insertTransaction = db.prepare(
    `INSERT INTO transactions (household_id, user_id, type, amount, category, description, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const alreadySynced = db.prepare(
    `SELECT 1 FROM open_finance_synced_transactions WHERE provider_transaction_id = ?`
  );

  let imported = 0;
  for (const tx of data.results || []) {
    if (alreadySynced.get(tx.id)) continue;
    const type = tx.amount < 0 ? "expense" : "income";
    const info = insertTransaction.run(
      user.household_id,
      userId,
      type,
      Math.abs(tx.amount),
      tx.category || "outros",
      tx.description || "",
      (tx.date || "").slice(0, 10)
    );
    insertSynced.run(tx.id, info.lastInsertRowid);
    imported++;
  }
  return imported;
}

module.exports = { configured, createConnectToken, saveItem, isConnected, syncItemTransactions };
