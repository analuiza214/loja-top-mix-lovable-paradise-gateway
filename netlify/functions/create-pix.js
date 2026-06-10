const https = require("https");
// Removido qrcode por incompatibilidade direta com Netlify Functions sem build step manual
// Nota: Certifique-se de que 'qrcode' não esteja sendo referenciado em nenhum lugar deste arquivo.

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

function generateCPF() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const calc = (n, m) => {
    const s = n.reduce((acc, v, i) => acc + v * (m - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  n.push(calc(n, 10));
  n.push(calc(n, 11));
  return n.join("");
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

  const apiKey = process.env.PARADISEPAGS_API_KEY;
  const productHash = process.env.PARADISEPAGS_PRODUCT_HASH;

  if (!apiKey || !productHash) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Configuração incompleta: PARADISEPAGS_API_KEY ou PARADISEPAGS_PRODUCT_HASH ausente." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }

  // Se for uma verificação de status (parâmetro hash na URL)
  const query = event.queryStringParameters || {};
  if (query.hash) {
    try {
      const statusUrl = `https://multi.paradisepags.com/api/v1/check_status.php?hash=${query.hash}`;
      const res = await httpsRequest("GET", statusUrl, null, { "X-API-KEY": apiKey });
      
      // A API Paradise geralmente retorna { status: "paid" } ou similar
      const isPaid = res.body?.status === "paid" || res.body?.data?.status === "paid";
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          status: isPaid ? "paid" : "pending",
          details: res.body
        }),
      };
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Erro ao consultar status." }) };
    }
  }

  // Lógica de criação de transação (One Click)
  const amount = body.amount || 49.00;
  const amountInCents = Math.round(Number(amount) * 100);
  const timestamp = Date.now();

  const payload = {
    amount: amountInCents,
    productHash: productHash,
    customer: {
      name: body.buyer?.name || "Cliente Loja",
      email: body.buyer?.email || `cliente_${timestamp}@email.com`,
      document: (body.buyer?.cpf || generateCPF()).replace(/\D/g, ""),
      phone: (body.buyer?.phone || "11999999999").replace(/\D/g, ""),
    }
  };

  try {
    const apiUrl = "https://multi.paradisepags.com/api/v1/transaction.php";
    const result = await httpsRequest("POST", apiUrl, payload, { "X-API-KEY": apiKey });

    if (result.status < 200 || result.status >= 300) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Erro na API ParadisePags", details: result.body }),
      };
    }

    const data = result.body;
    
    // Busca exaustiva pelo código PIX e QR Code
    const findPix = (obj) => {
      if (!obj) return null;
      for (let key in obj) {
        if (typeof obj[key] === 'string' && (obj[key].includes('000201') || obj[key].length > 100)) return obj[key];
        if (typeof obj[key] === 'object') {
          const found = findPix(obj[key]);
          if (found) return found;
        }
      }
      return null;
    };

    const findQrCode = (obj) => {
      if (!obj) return null;
      for (let key in obj) {
        const val = obj[key];
        if (typeof val === 'string') {
          if (val.startsWith('data:image') || (val.length > 500 && !val.includes(' '))) return val;
          if (key.toLowerCase().includes('qrcode') && (val.startsWith('http') || val.length > 100)) return val;
        }
        if (typeof val === 'object') {
          const found = findQrCode(val);
          if (found) return found;
        }
      }
      return null;
    };

    const pixCode = findPix(data);
    const externalId = data.hash || data.transaction_id || (data.data && (data.data.hash || data.data.id));

    // Enviar o pixCode para que o frontend gere o QR Code usando a biblioteca local
    let finalQrCodeBase64 = data.qrcode_base64 || (data.data && data.data.qrcode_base64);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        transactionId: externalId,
        pixCode: pixCode,
        qrCodeBase64: finalQrCodeBase64,
        qrCodeImage: data.qrcode_url || (data.data && data.data.qrcode_url)
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Erro de conexão." }) };
  }
};