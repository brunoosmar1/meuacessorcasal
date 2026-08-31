const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const TEST_DB = path.join(__dirname, "test-household.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.DB_PATH = TEST_DB;

const { db, getOrCreateUser, joinHousehold, getHouseholdMembers } = require("../src/db");
const { executeIntent } = require("../src/actions");

test("dois usuários novos começam em famílias separadas", () => {
  const alice = getOrCreateUser("5511800000001", "Alice");
  const bob = getOrCreateUser("5511800000002", "Bob");
  assert.notEqual(alice.household_id, bob.household_id);
});

test("entrar com código de convite une as famílias e migra o histórico", async () => {
  const carla = getOrCreateUser("5511800000003", "Carla");
  const davi = getOrCreateUser("5511800000004", "Davi");

  // Carla registra um gasto antes de convidar o Davi
  await executeIntent(
    carla,
    { intent: "transaction", type: "expense", amount: 80, category: "mercado", description: "compras da semana", occurred_at: "2026-08-20" },
    "2026-08-20"
  );

  const carlaHousehold = db.prepare("SELECT * FROM households WHERE id = ?").get(carla.household_id);
  const result = joinHousehold(davi.id, carlaHousehold.invite_code);
  assert.equal(result.ok, true);

  const davi2 = getOrCreateUser("5511800000004"); // recarrega do banco após o join
  assert.equal(davi2.household_id, carla.household_id, "Davi deve estar na mesma família de Carla agora");

  const members = getHouseholdMembers(carla.household_id);
  assert.equal(members.length, 2);
});

test("gasto lançado por um membro aparece no relatório do outro", async () => {
  const eva = getOrCreateUser("5511800000005", "Eva");
  const felipe = getOrCreateUser("5511800000006", "Felipe");

  const evaHousehold = db.prepare("SELECT * FROM households WHERE id = ?").get(eva.household_id);
  joinHousehold(felipe.id, evaHousehold.invite_code);
  const felipe2 = getOrCreateUser("5511800000006");

  await executeIntent(
    eva,
    { intent: "transaction", type: "expense", amount: 120, category: "lazer", description: "cinema", occurred_at: "2026-08-15" },
    "2026-08-15"
  );
  await executeIntent(
    felipe2,
    { intent: "transaction", type: "expense", amount: 45, category: "transporte", description: "uber", occurred_at: "2026-08-15" },
    "2026-08-15"
  );

  // Felipe pede o resumo da família e deve ver o gasto que a Eva lançou (e vice-versa)
  const reportForFelipe = await executeIntent(felipe2, { intent: "report", period: "month" }, "2026-08-15");
  assert.match(reportForFelipe, /lazer/);
  assert.match(reportForFelipe, /transporte/);
  assert.match(reportForFelipe, /Eva/);
  assert.match(reportForFelipe, /Felipe/);

  const reportForEva = await executeIntent(eva, { intent: "report", period: "month" }, "2026-08-15");
  assert.match(reportForEva, /lazer/);
  assert.match(reportForEva, /transporte/);
});

test("orçamento definido por um membro vale para a família inteira", async () => {
  const gustavo = getOrCreateUser("5511800000007", "Gustavo");
  const helena = getOrCreateUser("5511800000008", "Helena");
  const gustavoHousehold = db.prepare("SELECT * FROM households WHERE id = ?").get(gustavo.household_id);
  joinHousehold(helena.id, gustavoHousehold.invite_code);
  const helena2 = getOrCreateUser("5511800000008");

  await executeIntent(gustavo, { intent: "budget", category: "restaurante", monthly_limit: 200 }, "2026-08-15");
  await executeIntent(
    gustavo,
    { intent: "transaction", type: "expense", amount: 120, category: "restaurante", description: "jantar", occurred_at: "2026-08-15" },
    "2026-08-15"
  );
  const reply = await executeIntent(
    helena2,
    { intent: "transaction", type: "expense", amount: 100, category: "restaurante", description: "almoço", occurred_at: "2026-08-16" },
    "2026-08-16"
  );

  // Helena gastou 100, mas somado com os 120 do Gustavo passa dos 200 do orçamento da família
  assert.match(reply, /ultrapassou o orçamento/);
});

test("contas a pagar lançadas por um membro aparecem para o outro", async () => {
  const igor = getOrCreateUser("5511800000009", "Igor");
  const julia = getOrCreateUser("5511800000010", "Julia");
  const igorHousehold = db.prepare("SELECT * FROM households WHERE id = ?").get(igor.household_id);
  joinHousehold(julia.id, igorHousehold.invite_code);
  const julia2 = getOrCreateUser("5511800000010");

  await executeIntent(igor, { intent: "bill", type: "payable", description: "condomínio", amount: 450, due_date: "2026-09-05" }, "2026-08-15");
  const list = await executeIntent(julia2, { intent: "list_bills" }, "2026-08-15");
  assert.match(list, /condomínio/);
  assert.match(list, /Igor/);
});

test.after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
  }
});
