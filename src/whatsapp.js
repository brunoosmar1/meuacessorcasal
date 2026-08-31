const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = "v20.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

function configured() {
  return Boolean(TOKEN && PHONE_NUMBER_ID);
}

async function sendText(to, body) {
  if (!configured()) {
    console.log(`[WhatsApp simulado] Para ${to}: ${body}`);
    return { simulated: true };
  }
  const res = await fetch(`${BASE}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Erro ao enviar mensagem WhatsApp:", errText);
  }
  return res.json();
}

// Baixa um arquivo de mídia (áudio/imagem/documento) recebido pelo webhook.
// O fluxo da Cloud API é: media_id -> GET url temporária -> GET bytes do arquivo.
async function downloadMedia(mediaId) {
  const metaRes = await fetch(`${BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const meta = await metaRes.json();
  if (!meta.url) throw new Error("Não foi possível obter a URL da mídia");

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const arrayBuffer = await fileRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mime_type,
  };
}

module.exports = { sendText, downloadMedia, configured };
