const { db } = require("./db");
const googleCalendar = require("./googleCalendar");

function formatBRL(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Nome curto pra identificar quem lançou algo dentro da família (ex: "Ana registrou...").
// Se a pessoa não colocou nome, usamos o telefone mesmo.
function firstName(user) {
  if (!user.name) return user.phone;
  return user.name.split(" ")[0];
}

function handleTransaction(user, data) {
  db.prepare(
    `INSERT INTO transactions (household_id, user_id, type, amount, category, description, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.household_id, user.id, data.type, data.amount, data.category, data.description || "", data.occurred_at);

  const label = data.type === "expense" ? "Gasto registrado" : "Receita registrada";
  let reply = `✅ ${label}: ${formatBRL(data.amount)} em "${data.category}".`;

  if (data.type === "expense") {
    const budget = db
      .prepare("SELECT * FROM budgets WHERE household_id = ? AND category = ?")
      .get(user.household_id, data.category);
    if (budget) {
      const month = data.occurred_at.slice(0, 7);
      const spent = db
        .prepare(
          `SELECT COALESCE(SUM(amount),0) as total FROM transactions
           WHERE household_id = ? AND type = 'expense' AND category = ? AND occurred_at LIKE ?`
        )
        .get(user.household_id, data.category, `${month}%`).total;
      if (spent > budget.monthly_limit) {
        reply += `\n⚠️ A família já ultrapassou o orçamento de ${formatBRL(budget.monthly_limit)} para "${data.category}" este mês (total: ${formatBRL(spent)}).`;
      } else if (spent > budget.monthly_limit * 0.8) {
        reply += `\n⚠️ A família já usou ${formatBRL(spent)} dos ${formatBRL(budget.monthly_limit)} do orçamento de "${data.category}" este mês.`;
      }
    }
  }
  return reply;
}

function handleBill(user, data) {
  db.prepare(
    `INSERT INTO bills (household_id, user_id, type, description, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.household_id, user.id, data.type, data.description, data.amount, data.due_date);
  const label = data.type === "payable" ? "Conta a pagar" : "Conta a receber";
  return `📌 ${label} salva: "${data.description}" - ${formatBRL(data.amount)}, vencimento em ${data.due_date}.`;
}

async function handleReminder(user, data) {
  const info = db
    .prepare(`INSERT INTO reminders (user_id, title, remind_at) VALUES (?, ?, ?)`)
    .run(user.id, data.title, data.remind_at);

  let reply = `🗓️ Lembrete criado: "${data.title}" para ${data.remind_at.replace("T", " ")}.`;

  if (googleCalendar.isConnected(user.id)) {
    try {
      const eventId = await googleCalendar.createEvent(user.id, data.title, data.remind_at);
      db.prepare(`UPDATE reminders SET google_event_id = ? WHERE id = ?`).run(eventId, info.lastInsertRowid);
      reply += "\n📅 Também adicionei no seu Google Agenda.";
    } catch (err) {
      console.error("Erro ao criar evento no Google Agenda:", err.message);
    }
  }
  return reply;
}

function handleMarkBillPaid(user, data) {
  const bill = db
    .prepare(
      `SELECT * FROM bills WHERE household_id = ? AND paid = 0 AND description LIKE ?
       ORDER BY due_date ASC LIMIT 1`
    )
    .get(user.household_id, `%${data.description_hint || ""}%`);
  if (!bill) return "Não encontrei nenhuma conta pendente com essa descrição.";
  db.prepare(`UPDATE bills SET paid = 1 WHERE id = ?`).run(bill.id);
  return `✅ Marquei "${bill.description}" (${formatBRL(bill.amount)}) como ${bill.type === "payable" ? "paga" : "recebida"}.`;
}

function handleMarkReminderDone(user, data) {
  const reminder = db
    .prepare(
      `SELECT * FROM reminders WHERE user_id = ? AND done = 0 AND title LIKE ?
       ORDER BY remind_at ASC LIMIT 1`
    )
    .get(user.id, `%${data.title_hint || ""}%`);
  if (!reminder) return "Não encontrei nenhum lembrete ativo com essa descrição.";
  db.prepare(`UPDATE reminders SET done = 1 WHERE id = ?`).run(reminder.id);
  return `✅ Lembrete "${reminder.title}" concluído.`;
}

function handleListBills(user) {
  const bills = db
    .prepare(
      `SELECT b.*, u.name as user_name, u.phone as user_phone FROM bills b
       JOIN users u ON u.id = b.user_id
       WHERE b.household_id = ? AND b.paid = 0 ORDER BY b.due_date ASC`
    )
    .all(user.household_id);
  if (bills.length === 0) return "Vocês não têm nenhuma conta pendente. 🎉";
  return "📌 Contas pendentes da família:\n" + bills.map(b =>
    `• ${b.description} — ${formatBRL(b.amount)} (${b.type === "payable" ? "a pagar" : "a receber"}, vence ${b.due_date}, lançada por ${firstName({ name: b.user_name, phone: b.user_phone })})`
  ).join("\n");
}

function handleUndoLastTransaction(user) {
  // Só desfaz lançamentos da própria pessoa — evita que alguém apague sem querer
  // um gasto que o cônjuge acabou de registrar.
  const last = db
    .prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
    .get(user.id);
  if (!last) return "Não encontrei nenhum lançamento seu recente para desfazer.";
  db.prepare(`DELETE FROM transactions WHERE id = ?`).run(last.id);
  const label = last.type === "expense" ? "Gasto" : "Receita";
  return `↩️ ${label} de ${formatBRL(last.amount)} em "${last.category}" foi removido.`;
}

function handleListReminders(user) {
  // Lembretes continuam pessoais (cada um tem sua própria agenda/rotina).
  const reminders = db
    .prepare(`SELECT * FROM reminders WHERE user_id = ? AND done = 0 ORDER BY remind_at ASC`)
    .all(user.id);
  if (reminders.length === 0) return "Você não tem lembretes ativos.";
  return "🗓️ Lembretes ativos:\n" + reminders.map(r =>
    `• ${r.title} — ${r.remind_at.replace("T", " ")}`
  ).join("\n");
}

function handleBudget(user, data) {
  db.prepare(
    `INSERT INTO budgets (household_id, category, monthly_limit) VALUES (?, ?, ?)
     ON CONFLICT(household_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
  ).run(user.household_id, data.category, data.monthly_limit);
  return `🎯 Orçamento definido para a família: ${formatBRL(data.monthly_limit)}/mês para "${data.category}".`;
}

function periodStart(period, todayISO) {
  const d = new Date(todayISO + "T00:00:00");
  if (period === "today") return todayISO;
  if (period === "week") {
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function handleReport(user, data, todayISO) {
  const start = periodStart(data.period || "month", todayISO);
  const rows = db
    .prepare(
      `SELECT type, category, SUM(amount) as total FROM transactions
       WHERE household_id = ? AND occurred_at >= ? GROUP BY type, category ORDER BY total DESC`
    )
    .all(user.household_id, start);

  if (rows.length === 0) return "Não encontrei lançamentos da família nesse período ainda.";

  const expenses = rows.filter((r) => r.type === "expense");
  const incomes = rows.filter((r) => r.type === "income");
  const totalExp = expenses.reduce((s, r) => s + r.total, 0);
  const totalInc = incomes.reduce((s, r) => s + r.total, 0);

  // Quebra por pessoa: ajuda a saber quem gastou o quê dentro da família.
  const byPerson = db
    .prepare(
      `SELECT u.name as name, u.phone as phone, SUM(t.amount) as total FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.household_id = ? AND t.type = 'expense' AND t.occurred_at >= ?
       GROUP BY t.user_id ORDER BY total DESC`
    )
    .all(user.household_id, start);

  let reply = `📊 Resumo da família desde ${start}:\nReceitas: ${formatBRL(totalInc)}\nDespesas: ${formatBRL(totalExp)}\nSaldo: ${formatBRL(totalInc - totalExp)}\n\nPor categoria (despesas):`;
  expenses.forEach((r) => {
    reply += `\n• ${r.category}: ${formatBRL(r.total)}`;
  });

  if (byPerson.length > 1) {
    reply += `\n\nPor pessoa:`;
    byPerson.forEach((p) => {
      reply += `\n• ${firstName(p)}: ${formatBRL(p.total)}`;
    });
  }
  return reply;
}

async function executeIntent(user, data, todayISO) {
  switch (data.intent) {
    case "transaction":
      return handleTransaction(user, data);
    case "bill":
      return handleBill(user, data);
    case "reminder":
      return handleReminder(user, data);
    case "budget":
      return handleBudget(user, data);
    case "report":
      return handleReport(user, data, todayISO);
    case "mark_bill_paid":
      return handleMarkBillPaid(user, data);
    case "mark_reminder_done":
      return handleMarkReminderDone(user, data);
    case "list_bills":
      return handleListBills(user);
    case "list_reminders":
      return handleListReminders(user);
    case "undo_last_transaction":
      return handleUndoLastTransaction(user);
    case "chat":
    default:
      return data.reply || "Pode me contar mais sobre isso?";
  }
}

module.exports = { executeIntent, formatBRL };
