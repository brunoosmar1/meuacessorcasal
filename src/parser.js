const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Você é o motor de interpretação de um assistente pessoal via WhatsApp,
parecido com o "Meu Assessor". Seu único trabalho é ler a mensagem do usuário e devolver
APENAS um JSON válido (sem markdown, sem texto extra) descrevendo a intenção.

Formatos possíveis de resposta:

1) Lançamento financeiro (gasto ou receita):
{"intent":"transaction","type":"expense"|"income","amount":number,"category":string,"description":string,"occurred_at":"YYYY-MM-DD"}

Categorias sugeridas para despesas: alimentação, transporte, moradia, lazer, saúde, educação, compras, assinaturas, outros.
Categorias sugeridas para receitas: salário, freelance, investimentos, outros.
Se a data não for mencionada, use a data de hoje (informada abaixo).

2) Conta a pagar ou receber (com vencimento futuro, ainda não paga):
{"intent":"bill","type":"payable"|"receivable","description":string,"amount":number,"due_date":"YYYY-MM-DD"}

3) Lembrete / compromisso de agenda:
{"intent":"reminder","title":string,"remind_at":"YYYY-MM-DDTHH:MM"}

4) Pedido de relatório/resumo financeiro:
{"intent":"report","period":"today"|"week"|"month"}

5) Definir orçamento (limite mensal) por categoria:
{"intent":"budget","category":string,"monthly_limit":number}

6) Marcar uma conta como paga/recebida (usuário menciona que já pagou/recebeu algo pendente):
{"intent":"mark_bill_paid","description_hint":string}

7) Marcar um lembrete como concluído:
{"intent":"mark_reminder_done","title_hint":string}

8) Listar contas pendentes:
{"intent":"list_bills"}

9) Listar lembretes ativos:
{"intent":"list_reminders"}

10) Desfazer/apagar o último lançamento (usuário pede para cancelar, apagar ou corrigir o gasto/receita que acabou de registrar):
{"intent":"undo_last_transaction"}

11) Qualquer outra coisa (saudação, dúvida, conversa geral):
{"intent":"chat","reply":string}

Regras:
- Responda SEMPRE em português do Brasil.
- Nunca invente valores: se faltar uma informação essencial (ex: valor do gasto), use intent "chat" pedindo o dado que falta.
- Retorne SOMENTE o objeto JSON, nada antes nem depois.`;

async function interpretMessage(text, todayISO) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: `${SYSTEM_PROMPT}\n\nData de hoje: ${todayISO}`,
    messages: [{ role: "user", content: text }],
  });

  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

  try {
    const cleaned = raw.replace(/^```json|```$/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return { intent: "chat", reply: "Não consegui entender direito, pode reformular?" };
  }
}

// Interpreta uma imagem (foto de boleto, nota fiscal, comprovante) usando o Claude com visão.
// base64Data: conteúdo da imagem em base64 (sem o prefixo data:...)
async function interpretImageMessage(base64Data, mimeType, todayISO, caption) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: `${SYSTEM_PROMPT}\n\nData de hoje: ${todayISO}\n\nA mensagem do usuário é uma IMAGEM (foto de boleto, nota fiscal ou comprovante). Extraia o valor, a data (de vencimento se for boleto, ou da compra se for nota/comprovante) e uma categoria/descrição adequada. Se for um boleto ainda não pago, use intent "bill". Se for um comprovante de uma compra já feita, use intent "transaction".`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64Data },
          },
          { type: "text", text: caption || "Analise esta imagem e extraia os dados." },
        ],
      },
    ],
  });

  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  try {
    const cleaned = raw.replace(/^```json|```$/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return { intent: "chat", reply: "Recebi a imagem, mas não consegui ler os dados dela. Pode me dizer o valor e a data manualmente?" };
  }
}

// Transcrição de áudio: a API do Claude não aceita áudio bruto como entrada.
// Plugue aqui o provedor de sua preferência (ex: Whisper da OpenAI, Deepgram, Google Speech-to-Text)
// e retorne o texto transcrito. Enquanto isso não for configurado, avisamos o usuário.
async function transcribeAudio(buffer, mimeType) {
  if (!process.env.TRANSCRIPTION_PROVIDER_URL) {
    return null; // sinaliza "não configurado" para quem chamou
  }
  // Exemplo de integração genérica via HTTP (ajuste para o provedor escolhido):
  const res = await fetch(process.env.TRANSCRIPTION_PROVIDER_URL, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: buffer,
  });
  const data = await res.json();
  return data.text || null;
}

module.exports = { interpretMessage, interpretImageMessage, transcribeAudio };
