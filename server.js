// server.js v16 — sync completo: usuarios + dados de vendas
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SYNC_FILE  = path.join(DATA_DIR, 'sync_users.json');
const SALES_DIR  = path.join(DATA_DIR, 'sales');
const PUB_DIR    = path.join(DATA_DIR, 'public_sales'); // dados publicos por vendedor
[DATA_DIR, SALES_DIR, PUB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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
  } catch(e) {}
  users = JSON.parse(JSON.stringify(DEFAULT_USERS));
  saveUsers();
}
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
loadUsers();

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
  } catch(e) {}
}
function saveSalesFile(uid, mesKey, data) {
  fs.writeFileSync(path.join(SALES_DIR, uid + '__' + mesKey + '.json'), JSON.stringify(data));
}
function deleteSalesFile(uid, mesKey) {
  const f = path.join(SALES_DIR, uid + '__' + mesKey + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
loadSalesData();

const sessions = new Map();
function createToken(uid) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { uid, at: Date.now() });
  return t;
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

function authMw(req, res, next) {
  const t = req.headers['x-auth-token'];
  if (!t) return res.status(401).json({ error: 'Nao autenticado' });
  const s = sessions.get(t);
  if (!s) return res.status(401).json({ error: 'Sessao expirada.' });
  const u = users[s.uid];
  if (!u) return res.status(401).json({ error: 'Usuario invalido' });
  req.user = u;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Acesso negado' });
    next();
  };
}

// ── AUTH ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  const u = Object.values(users).find(x => x.id === usuario);
  if (!u || u.senha !== senha) return res.status(401).json({ error: 'Usuario ou senha invalidos' });
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

// ── SYNC USUARIOS (sem senha) ─────────────────────────
app.get('/api/public/users', (req, res) => {
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const d = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      if (Array.isArray(d) && d.length > 0) return res.json(d);
    }
  } catch(e) {}
  res.json(Object.values(users).map(u => ({ usuario: u.id, nome: u.nome, codigo: u.cod || '', role: u.role })));
});
app.post('/api/push-users', (req, res) => {
  const { users: list } = req.body || {};
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: 'lista invalida' });
  const clean = list.map(u => ({
    usuario: String(u.usuario || '').toLowerCase().trim(),
    nome: String(u.nome || '').toUpperCase().trim(),
    codigo: String(u.codigo || '').trim(),
    role: ['admin','gerente','vendedor'].includes(u.role) ? u.role : 'vendedor'
  })).filter(u => u.usuario);
  if (clean.length === 0) return res.status(400).json({ error: 'nenhum usuario valido' });
  fs.writeFileSync(SYNC_FILE, JSON.stringify(clean, null, 2));
  res.json({ ok: true, count: clean.length });
});

// ── SYNC DADOS DE VENDAS (sem auth) ──────────────────
// Vendedor empurra seu estado completo apos importar PDF
app.post('/api/public/sales-push', (req, res) => {
  const { usuario, estado } = req.body || {};
  if (!usuario || typeof usuario !== 'string') return res.status(400).json({ error: 'usuario obrigatorio' });
  if (!estado || !estado.meses || !estado.clientes) return res.status(400).json({ error: 'estado invalido' });
  const fname = path.join(PUB_DIR, usuario.toLowerCase().trim() + '.json');
  fs.writeFileSync(fname, JSON.stringify({ usuario, estado, updatedAt: Date.now() }));
  res.json({ ok: true });
});

// Admin/gerente busca dados de todos os vendedores
app.get('/api/public/sales', (req, res) => {
  try {
    // Carrega metadados de usuarios (sync_users.json > users.json)
    let syncUsers = [];
    try {
      if (fs.existsSync(SYNC_FILE)) syncUsers = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      if (!Array.isArray(syncUsers) || syncUsers.length === 0)
        syncUsers = Object.values(users).map(u => ({ usuario: u.id, nome: u.nome, codigo: u.cod || '', role: u.role }));
    } catch(e) {}
    const userMap = {};
    syncUsers.forEach(u => { userMap[u.usuario] = u; });

    const result = {};
    fs.readdirSync(PUB_DIR).filter(f => f.endsWith('.json')).forEach(file => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(PUB_DIR, file), 'utf8'));
        if (d.usuario && d.estado) {
          const meta = userMap[d.usuario] || { nome: d.usuario, codigo: '', role: 'vendedor' };
          result[d.usuario] = { estado: d.estado, updatedAt: d.updatedAt, meta };
        }
      } catch(e) {}
    });
    res.json(result);
  } catch(e) {
    res.json({});
  }
});

// ── USERS (admin) ─────────────────────────────────────
app.get('/api/users', authMw, requireRole('admin'), (req, res) => {
  res.json(Object.values(users).map(u => ({ id: u.id, nome: u.nome, role: u.role, cod: u.cod })));
});
app.post('/api/users', authMw, requireRole('admin'), (req, res) => {
  const { id, nome, senha, role, cod } = req.body || {};
  if (!id || !nome || !senha) return res.status(400).json({ error: 'campos obrigatorios' });
  if (!['admin','gerente','vendedor'].includes(role)) return res.status(400).json({ error: 'role invalido' });
  // Upsert: cria ou atualiza (admin pode re-registrar usuario de outro computador)
  users[id] = { id, nome: nome.toUpperCase(), senha, role, cod: cod || null };
  saveUsers();
  res.json({ ok: true });
});
app.put('/api/users/:id', authMw, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  if (!users[id]) return res.status(404).json({ error: 'Nao encontrado' });
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
  if (id === req.user.id) return res.status(400).json({ error: 'Nao pode remover a si mesmo' });
  if (!users[id]) return res.status(404).json({ error: 'Nao encontrado' });
  delete users[id];
  saveUsers();
  res.json({ ok: true });
});

// ── SALES (autenticado) ───────────────────────────────
app.get('/api/sales', authMw, (req, res) => {
  if (req.user.role === 'vendedor') return res.json(salesData[req.user.id] || {});
  const result = {};
  Object.keys(salesData).forEach(uid => {
    const u = users[uid];
    if (u) result[uid] = { nome: u.nome, role: u.role, cod: u.cod, data: salesData[uid] };
  });
  res.json(result);
});
app.post('/api/sales/:mesKey', authMw, (req, res) => {
  const { mesKey } = req.params;
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Dados invalidos' });
  if (!salesData[req.user.id]) salesData[req.user.id] = {};
  salesData[req.user.id][mesKey] = data;
  saveSalesFile(req.user.id, mesKey, data);
  res.json({ ok: true });
});
app.delete('/api/sales/:mesKey', authMw, (req, res) => {
  const { mesKey } = req.params;
  deleteSalesFile(req.user.id, mesKey);
  if (salesData[req.user.id]) delete salesData[req.user.id][mesKey];
  res.json({ ok: true });
});

// ── PARSER v15 (sem auth) ─────────────────────────────
const MESES_MAP  = {1:'jan',2:'fev',3:'mar',4:'abr',5:'mai',6:'jun',7:'jul',8:'ago',9:'set',10:'out',11:'nov',12:'dez'};
const MESES_NOME = {jan:'Janeiro',fev:'Fevereiro',mar:'Marco',abr:'Abril',mai:'Maio',jun:'Junho',jul:'Julho',ago:'Agosto',set:'Setembro',out:'Outubro',nov:'Novembro',dez:'Dezembro'};
function parseBR(s) {
  const n = parseFloat(String(s).replace(/\./g,'').replace(',','.'));
  return isNaN(n) ? null : n;
}
function parseLines(lines) {
  const clientes = {};
  let pedidos = 0, mesKey = null, ano = null, resumoTotal = null, resumoPedidos = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!mesKey) {
      const m = line.match(/Per[ií]odo\s+\d{2}\/(\d{2})\/(\d{4})/i) ||
                line.match(/\d{2}\/(\d{2})\/(\d{4})\s+a\s+\d{2}\/\d{2}\/\d{4}/);
      if (m) { mesKey = MESES_MAP[parseInt(m[m.length-2])]; ano = m[m.length-1]; }
    }
    if (resumoTotal === null && line.toUpperCase().includes('TOTAL GERAL')) {
      const nums = line.split(/\s+/).map(parseBR).filter(n => n !== null);
      const totais = nums.filter(n => n > 10000);
      if (totais.length > 0) {
        resumoTotal = Math.max(...totais);
        const cands = nums.filter(n => n > 50 && n < 10000 && Number.isInteger(n));
        if (cands.length > 0) resumoPedidos = cands[0];
      }
    }
    if (!/^\d{2}\/\d{2}\/\d{4}\s/.test(line)) continue;
    const mV = line.match(/([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+[-\d.]+,\d+\s+[-\d.]+,\d+\s+[-\d.]+,\d+\s*$/);
    if (!mV) continue;
    const mCod = line.match(/\b(\d{5})\b\s+(.+?)\s*CPF\/CNPJ/i);
    if (!mCod) continue;
    const cod = mCod[1], nome = mCod[2].trim().replace(/\s+/g, ' ');
    const total = parseBR(mV[3]);
    if (total === null || total === 0) continue;
    pedidos++;
    if (!clientes[cod]) clientes[cod] = { nome: '', total: 0 };
    if (nome.length > clientes[cod].nome.length) clientes[cod].nome = nome;
    clientes[cod].total = Math.round((clientes[cod].total + total) * 100) / 100;
  }
  if (clientes['55555']) clientes['55555'].nome = 'CONSUMIDOR / BALCAO';
  for (const cod of Object.keys(clientes)) { if (clientes[cod].total === 0) delete clientes[cod]; }
  let grandTotal = Math.round(Object.values(clientes).reduce((s, c) => s + c.total, 0) * 100) / 100;
  if (resumoTotal && resumoTotal > 0 && Math.abs(grandTotal - resumoTotal) > 1) {
    const scale = resumoTotal / grandTotal;
    for (const cod of Object.keys(clientes)) clientes[cod].total = Math.round(clientes[cod].total * scale * 100) / 100;
    grandTotal = resumoTotal;
  }
  const label = mesKey ? (MESES_NOME[mesKey] + '/' + (ano || '')) : 'Desconhecido';
  return { mes: mesKey || 'jan', label, total: grandTotal, pedidos: resumoPedidos || pedidos, meta: 0, clientes };
}

app.post('/api/parse-text', (req, res) => {
  const { lines } = req.body || {};
  if (!lines || !Array.isArray(lines)) return res.status(400).json({ error: 'lines[] obrigatorio' });
  try {
    const result = parseLines(lines);
    if (!result.mes || Object.keys(result.clientes).length === 0)
      return res.status(422).json({ error: 'Nenhum lancamento encontrado.' });
    return res.json({ success: true, ...result });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Painel Douratubos v15 em http://localhost:' + PORT));
