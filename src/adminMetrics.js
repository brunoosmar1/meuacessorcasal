const { db } = require("./db");

function getMetrics() {
  const totalUsers = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;

  const activeUsers7d = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as n FROM messages
       WHERE direction = 'in' AND created_at >= datetime('now', '-7 days')`
    )
    .get().n;

  const activeUsers30d = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as n FROM messages
       WHERE direction = 'in' AND created_at >= datetime('now', '-30 days')`
    )
    .get().n;

  const totalMessages = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE direction = 'in'`).get().n;

  const totalTransactions = db.prepare(`SELECT COUNT(*) as n FROM transactions`).get().n;

  const volumeThisMonth = db
    .prepare(
      `SELECT type, COALESCE(SUM(amount),0) as total FROM transactions
       WHERE occurred_at >= date('now','start of month') GROUP BY type`
    )
    .all();

  const googleConnections = db.prepare(`SELECT COUNT(*) as n FROM google_tokens`).get().n;
  const openFinanceConnections = db
    .prepare(`SELECT COUNT(DISTINCT user_id) as n FROM open_finance_items WHERE status = 'active'`)
    .get().n;

  const newestUsers = db
    .prepare(`SELECT phone, name, created_at FROM users ORDER BY id DESC LIMIT 10`)
    .all();

  const messagesPerDay = db
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as n FROM messages
       WHERE direction = 'in' AND created_at >= datetime('now', '-14 days')
       GROUP BY day ORDER BY day ASC`
    )
    .all();

  return {
    totalUsers,
    activeUsers7d,
    activeUsers30d,
    totalMessages,
    totalTransactions,
    volumeThisMonth,
    googleConnections,
    openFinanceConnections,
    newestUsers,
    messagesPerDay,
  };
}

module.exports = { getMetrics };
