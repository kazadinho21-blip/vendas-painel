// v2 - parser preciso
require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

const UFS = new Set(['MS','PR','SP','RJ','MG','GO','MT','RS','SC','BA','PE','CE','PA','AM','RO','TO','MA','PI','RN','PB','AL','SE','ES','DF','AC','AP','RR']);
const MESES_MAP = {1:'jan',2:'fev',3:'mar',4:'abr',5:'mai',6:'jun',7:'jul',8:'ago',9:'set',10:'out',11:'nov',12:'dez'};
const MESES_NOME = {jan:'Janeiro',fev:'Fevereiro',mar:'Março',abr:'Abril',mai:'Maio',jun:'Junho',jul:'Julho',ago:'Agosto',set:'Setembro',out:'Outubro',nov:'Novembro',dez:'Dezembro'};

function parseBR(s) {
  if (s.includes('/')) return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseLines(lines) {
  const clientes = {};
  let pedidos = 0;
  let mesKey = null, ano = null;

  for (const line of lines) {
    const t = line.trim();
    if (!mesKey) {
      const m = t.match(/Per[ií]odo\s+\d{2}\/(\d{2})\/(\d{4})/i) || t.match(/\d{2}\/(\d{2})\/(\d{4})\s+a\s/);
      if (m) { mesKey = MESES_MAP[parseInt(m[1])]; ano = m[2]; }
    }
    const parts = t.split(/\s+/);
    if (parts.length < 10) continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(parts[0])) continue;
    let cod = null, codIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d{5}$/.test(parts[i])) { cod = parts[i]; codIdx = i; break; }
    }
    if (!cod) continue;
    let ufIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (UFS.has(parts[i])) { ufIdx = i; break; }
    }
    if (ufIdx < 0) continue;
    const nums = parts.slice(ufIdx + 1).map(parseBR).filter(n => n !== null);
    if (nums.length < 3) continue;
    const total = nums[2];
    pedidos++;
    const cpfIdx = parts.findIndex(p => p.includes('CPF') || p.includes('CNPJ'));
    const nome = (cpfIdx > codIdx) ? parts.slice(codIdx + 1, cpfIdx).join(' ') : '';
    if (!clientes[cod]) clientes[cod] = { nome: '', total: 0 };
    if (nome.length > clientes[cod].nome.length) clientes[cod].nome = nome;
    clientes[cod].total = Math.round((clientes[cod].total + total) * 100) / 100;
  }

  if (clientes['55555']) clientes['55555'].nome = 'CONSUMIDOR / BALCAO';
  const grandTotal = Math.round(Object.values(clientes).reduce((s, c) => s + c.total, 0) * 100) / 100;
  const label = mesKey ? `${MESES_NOME[mesKey]}/${ano}` : 'Desconhecido';
  return { mes: mesKey || 'jan', label, total: grandTotal, pedidos, meta: 0, clientes };
}

app.post('/api/parse-text', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { lines } = req.body || {};
  if (!lines || !Array.isArray(lines)) return res.status(400).json({ error: 'lines[] obrigatorio.' });
  try {
    const result = parseLines(lines);
    if (!result.mes || Object.keys(result.clientes).length === 0) {
      return res.status(422).json({ error: 'Nenhum lancamento encontrado. Verifique o PDF.' });
    }
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Painel Douratubos rodando em http://localhost:${PORT}`);
});
