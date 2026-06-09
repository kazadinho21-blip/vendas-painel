require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const PROMPT = `Voce esta analisando um relatorio de VENDAS POR VENDEDOR da Douratubos.

TAREFA: Leia TODO o documento. Extraia TODOS os lancamentos agrupando por codigo de cliente.

REGRAS:
1. CODIGO cliente = 5 digitos numericos (ex: 00763, 55555)
2. 55555 = CONSUMIDOR/BALCAO — inclua normalmente
3. Lancamentos com DEVOLUCAO ou DEV. = valor NEGATIVO
4. Some TODOS os totais do mesmo cliente (varias paginas)
5. Detecte periodo (mes/ano) no cabecalho

MESES: janeiro=jan|fevereiro=fev|marco=mar|abril=abr|maio=mai|junho=jun|julho=jul|agosto=ago|setembro=set|outubro=out|novembro=nov|dezembro=dez

RETORNE APENAS JSON (sem markdown):
{"mes":"jun","label":"Junho/2026","total":195374.68,"pedidos":0,"meta":0,"clientes":{"30164":{"nome":"NOME DO CLIENTE","total":15000.00},"55555":{"nome":"CONSUMIDOR / BALCAO","total":2300.00}}}`;

app.post('/api/parse-pdf', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada no arquivo .env' });
  }

  const { pdf_base64 } = req.body || {};
  if (!pdf_base64) {
    return res.status(400).json({ error: 'pdf_base64 obrigatorio.' });
  }
  if (pdf_base64.length > 6000000) {
    return res.status(413).json({ error: 'PDF muito grande. Use processamento local.' });
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    const raw = (message.content[0]?.text || '').trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (_) {
      const m = jsonStr.match(/\{[\s\S]+\}/);
      if (m) result = JSON.parse(m[0]);
      else throw new Error('Claude nao retornou JSON valido: ' + raw.substring(0, 200));
    }

    if (!result.mes || typeof result.clientes !== 'object') {
      throw new Error('JSON incompleto — campos mes ou clientes ausentes.');
    }

    result.total = Math.round(
      Object.values(result.clientes).reduce((s, c) => s + (c.total || 0), 0) * 100
    ) / 100;

    return res.status(200).json({
      success: true,
      mes: result.mes,
      label: result.label,
      total: result.total,
      pedidos: result.pedidos || 0,
      meta: result.meta || 0,
      clientes: result.clientes,
    });

  } catch (err) {
    console.error('Erro parse-pdf:', err.message);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

app.listen(PORT, () => {
  console.log(`Painel Douratubos rodando em http://localhost:${PORT}`);
});
