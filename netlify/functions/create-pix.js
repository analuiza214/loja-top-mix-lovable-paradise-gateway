const https = require("https");

function httpsRequest(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Nova variável para ParadisePags
  const apiKey = process.env.PARADISEPAGS_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Gateway ParadisePags não configurado. Adicione PARADISEPAGS_API_KEY nas env vars." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido." }) };
  }

  const { amount, buyer, transactionId, productName } = body;

  // ParadisePags espera o valor em centavos (inteiro)
  const amountInCents = Math.round(Number(amount) * 100);

  const payload = {
    amount: amountInCents,
    description: productName || "Compra na Loja",
    reference: String(transactionId || `order_${Date.now()}`),
    customer: {
      name: buyer?.name || "Cliente",
      email: buyer?.email || "cliente@email.com",
      phone: String(buyer?.phone || "").replace(/\D/g, ""),
      document: String(buyer?.cpf || "").replace(/\D/g, ""),
    }
  };

  try {
    const apiUrl = "https://multi.paradisepags.com/api/v1/transaction.php";
    
    const result = await httpsRequest("POST", apiUrl, payload, {
      "X-API-Key": apiKey
    });

    // Logging para debug (opcional, remover em produção se desejar)
    console.log("ParadisePags Status:", result.status);
    console.log("ParadisePags Response:", JSON.stringify(result.body));

    if (result.status < 200 || result.status >= 300) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Erro na ParadisePags: " + (result.body.message || "Erro desconhecido"),
          details: result.body
        }),
      };
    }

    const data = result.body;

    // Mapeamento da resposta da ParadisePags para o frontend
    // Ajustar baseado no retorno real da API (geralmente data.pix_code ou similar)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        transactionId: data.transaction_id || data.id || transactionId,
        pixCode: data.pix_code || data.copy_paste || data.code,
        qrCodeBase64: data.pix_qr_code || data.qrcode_base64,
        qrCodeImage: data.qrcode_url,
      }),
    };
  } catch (err) {
    console.error("Erro na função create-pix:", err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Erro de comunicação com o gateway ParadisePags." }),
    };
  }
};