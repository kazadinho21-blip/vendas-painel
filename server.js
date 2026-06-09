require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const PROMPT = `Analise o relatorio de VENDAS POR VENDEDOR da Douratubos e retorne APENAS um objeto JSON.

ESTRUTURA DE CADA LINHA:
EMISSAO | PEDIDO | NOTA | CFOP | CONDICAO | COD_CLIENTE(5 digitos) | NOME_CLIENTE | CPF/CNPJ | NR_DOC | CIDADE | UF | QTDE | PRECO_UNIT | TOTAL | PECA | SERVICO | COMISSAO

INSTRUCOES:
- Some a coluna TOTAL (nao some TOTAL+PECA, sao duplicatas na mesma linha)
- Agrupe por COD_CLIENTE (5 digitos numericos)
- Linhas com DEV./DEVOLUCAO ja tem valor negativo - inclua normalmente
- Ignore linhas de cabecalho, subtotal e rodape
- 55555 = CONSUMIDOR/BALCAO - inclua normalmente
- Mes/ano: detecte do cabecalho (ex: "01/01/2026 a 31/01/2026" = jan/2026)

MESES: janeiro=jan|fevereiro=fev|marco=mar|abril=abr|maio=mai|junho=jun|julho=jul|agosto=ago|setembro=set|outubro=out|novembro=nov|dezembro=dez

FORMATO DE SAIDA - retorne SOMENTE este JSON sem nenhum texto antes ou depois:
{"mes":"jan","label":"Janeiro/2026","total":336524.50,"pedidos":573,"meta":0,"clientes":{"28181":{"nome":"ESSENCE EMPREENDIMENTOS LTDA","total":45574.51},"55555":{"nome":"CONSUMIDOR / BALCAO","total":22938.49}}}

IMPORTANTE: NAO explique raciocinio. NAO liste clientes em texto. Comece com { e termine com }.`;

app.post('/api/parse-pdf', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada no arquivo .env' });

  const { pdf_base64 } = req.body || {};
  if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 obrigatorio.' });
  if (pdf_base64.length > 8000000) return res.status(413).json({ error: 'PDF muito grande. Use processamento local.' });

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
            { type: 'text', text: PROMPT },
          ],
        },
        {
          role: 'assistant',
          content: '{'
        }
      ],
    });

    const raw = '{' + (message.content[0]?.text || '').trim();
    const jsonStr = raw.replace(/```(?:json)?\s*/gi, '').trim();

    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (_) {
      const m = jsonStr.match(/\{[\s\S]+\}/);
      if (m) result = JSON.parse(m[0]);
      else throw new Error('Claude nao retornou JSON valido: ' + raw.substring(0, 300));
    }

    if (!result.mes || typeof result.clientes !== 'object') {
      throw new Error('JSON incompleto - campos mes ou clientes ausentes.');
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
