const cron = require("node-cron");
const { db, cleanupExpired } = require("./db");
const whatsapp = require("./whatsapp");

// Roda a cada minuto: dispara lembretes cujo horário chegou.
function checkReminders() {
  const now = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const due = db
    .prepare(
      `SELECT r.*, u.phone FROM reminders r
       JOIN users u ON u.id = r.user_id
       WHERE r.done = 0 AND r.notified = 0 AND r.remind_at <= ?`
    )
    .all(now);

  for (const r of due) {
    whatsapp.sendText(r.phone, `🔔 Lembrete: ${r.title}`);
    db.prepare(`UPDATE reminders SET notified = 1 WHERE id = ?`).run(r.id);
  }
}

// Roda uma vez por dia: avisa sobre contas que vencem hoje ou amanhã.
function checkBills() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const todayISO = today.toISOString().slice(0, 10);
  const tomorrowISO = tomorrow.toISOString().slice(0, 10);

  const due = db
    .prepare(
      `SELECT b.*, u.phone FROM bills b
       JOIN users u ON u.id = b.user_id
       WHERE b.paid = 0 AND b.notified = 0 AND b.due_date IN (?, ?)`
    )
    .all(todayISO, tomorrowISO);

  for (const b of due) {
    const when = b.due_date === todayISO ? "vence hoje" : "vence amanhã";
    const label = b.type === "payable" ? "Conta a pagar" : "Conta a receber";
    whatsapp.sendText(
      b.phone,
      `⏰ ${label} ${when}: "${b.description}" — R$ ${b.amount.toFixed(2)}`
    );
    db.prepare(`UPDATE bills SET notified = 1 WHERE id = ?`).run(b.id);
  }
}

function start() {
  cron.schedule("* * * * *", checkReminders);
  cron.schedule("0 8 * * *", checkBills); // todo dia às 8h
  cron.schedule("0 4 * * *", cleanupExpired); // limpeza diária de sessões/códigos expirados
  console.log("⏱️  Agendador de lembretes e contas iniciado.");
}

module.exports = { start };
