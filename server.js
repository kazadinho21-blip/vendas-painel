require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const PROMPT = `Voce esta analisando um relatorio de VENDAS POR VENDEDOR da Douratubos.

ESTRUTURA DE CADA LINHA DO RELATORIO:
EMISSAO | PEDIDO | NOTA | CFOP | CONDICAO | COD_CLIENTE | NOME_CLIENTE | CPF/CNPJ | NR_DOC | CIDADE | UF | QTDE | PRECO_UNIT | TOTAL | PECA | SERVICO | COMISSAO

COLUNA CORRETA: use APENAS a coluna TOTAL (7a coluna apos UF). NAO some TOTAL + PECA — sao a mesma coisa em colunas diferentes.

TAREFA: Leia TODO o documento. Para cada linha de venda, some o valor da coluna TOTAL agrupando por COD_CLIENTE.

REGRAS:
1. COD_CLIENTE = exatamente 5 digitos numericos (ex: 00763, 55555)
2. 55555 = CONSUMIDOR/BALCAO — inclua normalmente
3. Linhas com DEVOLUCAO ou DEV. no campo CFOP = valor NEGATIVO (ja aparecem negativos no PDF)
4. Some todos os lancamentos do mesmo COD_CLIENTE em todas as paginas
5. Ignore linhas de subtotal, cabecalho ou rodape
6. O TOTAL GERAL do JSON deve bater com "TOTAL GERAL" impresso no rodape do PDF
7. Detecte mes/ano no cabecalho (ex: "Periodo 01/01/2026 a 31/01/2026" = janeiro/jan)

MESES: janeiro=jan|fevereiro=fev|marco=mar|abril=abr|maio=mai|junho=jun|julho=jul|agosto=ago|setembro=set|outubro=out|novembro=nov|dezembro=dez

RETORNE APENAS JSON valido (sem markdown, sem texto extra):
{"mes":"jan","label":"Janeiro/2026","total":336524.50,"pedidos":573,"meta":0,"clientes":{"28181":{"nome":"ESSENCE EMPREENDIMENTOS LTDA","total":45574.51},"55555":{"nome":"CONSUMIDOR / BALCAO","total":22938.49}}}`;

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
