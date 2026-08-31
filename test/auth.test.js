const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const TEST_DB = path.join(__dirname, "test-auth.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.DB_PATH = TEST_DB;
process.env.ADMIN_PHONE = "5511900000099";

const { db, getOrCreateUser } = require("../src/db");
const authModule = require("../src/auth");

// auth.js chama whatsapp.sendText por baixo dos panos; como não há credenciais
// reais no ambiente de teste, ele cai automaticamente no modo "simulado" (loga
// no console em vez de enviar de verdade) — não precisa de mock.

test("gera código, verifica e cria sessão válida", async () => {
  const phone = "5511911110001";
  const result = await authModule.requestLoginCode(phone, "Grazi");
  assert.equal(result.sent, true);
  assert.ok(result.devCode, "em modo simulado, o código deve vir na resposta para testes");

  const verify = authModule.verifyLoginCode(phone, result.devCode);
  assert.equal(verify.ok, true);
  assert.ok(verify.token);

  const user = authModule.getUserBySession(verify.token);
  assert.equal(user.phone, phone);
});

test("rejeita código incorreto", async () => {
  const phone = "5511911110002";
  await authModule.requestLoginCode(phone, "Léo");
  const verify = authModule.verifyLoginCode(phone, "000000");
  assert.equal(verify.ok, false);
});

test("rejeita verificação sem código pendente", () => {
  const verify = authModule.verifyLoginCode("5511911119999", "123456");
  assert.equal(verify.ok, false);
  assert.match(verify.error, /Nenhum código pendente/);
});

test("usuário com ADMIN_PHONE nasce como admin automaticamente", () => {
  const user = getOrCreateUser("5511900000099", "Admin");
  assert.equal(user.is_admin, 1);
});

test("usuário comum não nasce como admin", () => {
  const user = getOrCreateUser("5511911110003", "Usuário comum");
  assert.equal(user.is_admin, 0);
});

test("sessão inválida/expirada não retorna usuário", () => {
  const user = authModule.getUserBySession("token-que-nao-existe");
  assert.equal(user, null);
});

test.after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
  }
});
