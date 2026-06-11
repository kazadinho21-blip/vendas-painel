// server.js v11 — multi-role: admin / gerente / vendedor
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Diretórios de dados ──────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SALES_DIR = path.join(DATA_DIR, 'sales');
[DATA_DIR, SALES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Usuários ─────────────────────────────────────────
const DEFAULT_USERS = {
  agner:    { id:'agner',    nome:'AGNER',          senha:'douratubos2026', role:'admin',    cod:'0065' },
  vinicius: { id:'vinicius', nome:'VINICIUS MATANA', senha:'vini123',       role:'vendedor', cod:'0061' }
};
let users = {};
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const d = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Object.keys(d).length > 0) { users = d; return; }
    }
  } catch(e) { console.error('loadUsers:', e.message); }
  users = JSON.parse(JSON.stringify(DEFAULT_USERS));
  saveUsers();
}
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
loadUsers();

// ── Dados de vendas ───────────────────────────────────
// salesData[userId][mesKey] = { mes, label, total, pedidos, meta, clientes }
let salesData = {};
function loadSalesData() {
  try {
    fs.readdirSync(SALES_DIR).filter(f => f.endsWith('.json')).forEach(file => {
      const [uid, mesKey] = file.replace('.json','').split('__');
      if (!uid || !mesKey) return;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(SALES_DIR, file), 'utf8'));
        if (!salesData[uid]) salesData[uid] = {};
        salesData[uid][mesKey] = d;
      } catch(e) {}
    });
    console.log(`Dados carregados para ${Object.keys(salesData).length} usuário(s)`);
  } catch(e) { console.error('loadSalesData:', e.message); }
}
function saveSalesFile(uid, mesKey, data) {
  fs.writeFileSync(path.join(SALES_DIR, `${uid}__${mesKey}.json`), JSON.stringify(data));
}
function deleteSalesFile(uid, mesKey) {
  const f = path.join(SALES_DIR, `${uid}__${mesKey}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
loadSalesData();

// ── Sessões (memória) ─────────────────────────────────
const sessions = new Map();
function createToken(uid) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { uid, at: Date.now() });
  return t;
}

// ── Middlewares ───────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));
function authMw(req, res, next) {
  const t = req.headers['x-auth-token'];
  if (!t) return res.status(401).json({ error: 'Não autenticado' });
  const s = sessions.get(t);
  if (!s) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  const u = users[s.uid];
  if (!u) return res.status(401).json({ error: 'Usuário inválido' });
  req.user = u;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Acesso negado' });
    next();
  };
}

// ══════════════════════════════════════════════════════
// ROTAS DE AUTENTICAÇÃO
// ══════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  const u = Object.values(users).find(x => x.id === usuario);
  if (!u || u.senha !== senha) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const token = createToken(u.id);
  res.json({ token, user: { id: u.id, nome: u.nome, role: u.role, cod: u.cod } });
});
app.post('/api/logout', authMw, (req, res) => {
  sessions.delete(req.headers['x-auth-token']);
  res.json({ ok: true });
});
app.get('/api/me', authMw, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, nome: u.nome, role: u.role, cod: u.cod });
});

// ══════════════════════════════════════════════════════
// GERENCIAMENTO DE USUÁRIOS (apenas admin)
// ══════════════════════════════════════════════════════
app.get('/api/users', authMw, requireRole('admin'), (req, res) => {
  res.json(Object.values(users).map(u => ({ id: u.id, nome: u.nome, role: u.role, cod: u.cod })));
});
app.post('/api/users', authMw, requireRole('admin'), (req, res) => {
  const { id, nome, senha, role, cod } = req.body || {};
  if (!id || !nome || !senha) return res.status(400).json({ error: 'id, nome e senha são obrigatórios' });
  if (users[id]) return res.status(409).json({ error: 'ID já existe' });
  if (!['admin','gerente','vendedor'].includes(role)) return res.status(400).json({ error: 'role inválido' });
  users[id] = { id, nome: nome.toUpperCase(), senha, role: role || 'vendedor', cod: cod || null };
  saveUsers();
  res.json({ ok: true });
});
app.put('/api/users/:id', authMw, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  if (!users[id]) return res.status(404).json({ error: 'Não encontrado' });
  const { nome, senha, role, cod } = req.body || {};
  if (nome) users[id].nome = nome.toUpperCase();
  if (senha) users[id].senha = senha;
  if (role && ['admin','gerente','vendedor'].includes(role)) users[id].role = role;
  if (cod !== undefined) users[id].cod = cod || null;
  saveUsers();
  res.json({ ok: true });
});
app.delete('/api/users/:id', authMw, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: 'Não pode remover a si mesmo' });
  if (!users[id]) return res.status(404).json({ error: 'Não encontrado' });
  delete users[id];
  saveUsers();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// DADOS DE VENDAS
// ══════════════════════════════════════════════════════

// GET /api/sales — vendedor vê seus dados; gerente/admin vê todos
app.get('/api/sales', authMw, (req, res) => {
  if (req.user.role === 'vendedor') {
    return res.json(salesData[req.user.id] || {});
  }
  // gerente/admin: retorna mapa userId → { nome, role, cod, data }
  const result = {};
  Object.keys(salesData).forEach(uid => {
    const u = users[uid];
    if (u) result[uid] = { nome: u.nome, role: u.role, cod: u.cod, data: salesData[uid] };
  });
  res.json(result);
});

// GET /api/sales/:userId — dados de usuário específico (gerente/admin)
app.get('/api/sales/:userId', authMw, requireRole('gerente','admin'), (req, res) => {
  res.json(salesData[req.params.userId] || {});
});

// POST /api/sales/:mesKey — salva mês para o usuário atual
app.post('/api/sales/:mesKey', authMw, (req, res) => {
  const { mesKey } = req.params;
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Dados inválidos' });
  if (!salesData[req.user.id]) salesData[req.user.id] = {};
  salesData[req.user.id][mesKey] = data;
  saveSalesFile(req.user.id, mesKey, data);
  res.json({ ok: true });
});

// DELETE /api/sales/:mesKey — remove mês do usuário atual
app.delete('/api/sales/:mesKey', authMw, (req, res) => {
  const { mesKey } = req.params;
  deleteSalesFile(req.user.id, mesKey);
  if (salesData[req.user.id]) delete salesData[req.user.id][mesKey];
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// PARSER (v10 com scaling)
// ══════════════════════════════════════════════════════
const UFS = new Set(['MS','PR','SP','RJ','MG','GO','MT','RS','SC','BA','PE','CE','PA','AM','RO','TO','MA','PI','RN','PB','AL','SE','ES','DF','AC','AP','RR']);
const MESES_MAP = {1:'jan',2:'fev',3:'mar',4:'abr',5:'mai',6:'jun',7:'jul',8:'ago',9:'set',10:'out',11:'nov',12:'dez'};
const MESES_NOME = {jan:'Janeiro',fev:'Fevereiro',mar:'Março',abr:'Abril',mai:'Maio',jun:'Junho',jul:'Julho',ago:'Agosto',set:'Setembro',out:'Outubro',nov:'Novembro',dez:'Dezembro'};

function parseBR(s) {
  if (s.includes('/')) return null;
  const n = parseFloat(s.replace(/\./g,'').replace(',','.'));
  return isNaN(n) ? null : n;
}

function parseLines(lines) {
  const clientes = {};
  let pedidos = 0, mesKey = null, ano = null, resumoTotal = null, resumoPedidos = null;

  for (const line of lines) {
    const t = line.trim();
    if (!mesKey) {
      const m = t.match(/Per[ií]odo\s+\d{2}\/(\d{2})\/(\d{4})/i) || t.match(/\d{2}\/(\d{2})\/(\d{4})\s+a\s/);
      if (m) { mesKey = MESES_MAP[parseInt(m[1])]; ano = m[2]; }
    }
    if (resumoTotal === null) {
      const lup = t.toUpperCase();
      if (lup.includes('TOTAL GERAL') || (lup.startsWith('0061') && lup.includes('VINICIUS'))) {
        const nums = t.split(/\s+/).map(parseBR).filter(n => n !== null);
        const totais = nums.filter(n => n > 100000);
        if (totais.length > 0) {
          resumoTotal = Math.max(...totais);
          const cands = nums.filter(n => n > 100 && n < 10000 && Number.isInteger(n));
          if (cands.length > 0) resumoPedidos = cands[0];
        }
      }
    }
    const parts = t.split(/\s+/);
    if (parts.length < 10) continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(parts[0])) continue;
    const pedidoNum = parts[1] || '';
    if (!pedidoNum || pedidoNum.startsWith('0')) continue;
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
    if (total <= 0) continue;
    pedidos++;
    const cpfIdx = parts.findIndex(p => p.includes('CPF') || p.includes('CNPJ'));
    const nome = (cpfIdx > codIdx) ? parts.slice(codIdx + 1, cpfIdx).join(' ') : '';
    if (!clientes[cod]) clientes[cod] = { nome:'', total:0 };
    if (nome.length > clientes[cod].nome.length) clientes[cod].nome = nome;
    clientes[cod].total = Math.round((clientes[cod].total + total) * 100) / 100;
  }

  if (clientes['55555']) clientes['55555'].nome = 'CONSUMIDOR / BALCAO';
  let grandTotal = Math.round(Object.values(clientes).reduce((s,c) => s + c.total, 0) * 100) / 100;

  if (resumoTotal && resumoTotal > 0 && Math.abs(grandTotal - resumoTotal) > 1) {
    const scale = resumoTotal / grandTotal;
    for (const cod of Object.keys(clientes)) {
      clientes[cod].total = Math.round(clientes[cod].total * scale * 100) / 100;
    }
    grandTotal = resumoTotal;
  }

  const label = mesKey ? `${MESES_NOME[mesKey]}/${ano}` : 'Desconhecido';
  return { mes: mesKey || 'jan', label, total: grandTotal, pedidos: resumoPedidos || pedidos, meta: 0, clientes };
}

app.post('/api/parse-text', authMw, (req, res) => {
  const { lines } = req.body || {};
  if (!lines || !Array.isArray(lines)) return res.status(400).json({ error: 'lines[] obrigatório' });
  try {
    const result = parseLines(lines);
    if (!result.mes || Object.keys(result.clientes).length === 0)
      return res.status(422).json({ error: 'Nenhum lançamento encontrado. Verifique o PDF.' });
    if (!salesData[req.user.id]) salesData[req.user.id] = {};
    salesData[req.user.id][result.mes] = result;
    saveSalesFile(req.user.id, result.mes, result);
    return res.json({ success: true, ...result });
  } catch(err) {
    console.error('parse-text error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Painel Douratubos v11 em http://localhost:${PORT}`));
