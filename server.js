const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ─── Persistência em arquivo ───────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const SALES_DIR = path.join(DATA_DIR, 'sales');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SALES_DIR)) fs.mkdirSync(SALES_DIR, { recursive: true });
}

const DEFAULT_USERS = [
  { id: 'agner',    nome: 'AGNER',    senha: 'douratubos2026', role: 'admin',   cod: '0065' },
  { id: 'vinicius', nome: 'VINICIUS', senha: 'vini123',        role: 'vendedor', cod: '0061' }
];

function loadUsers() {
  ensureDirs();
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(DEFAULT_USERS, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_USERS));
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  ensureDirs();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUserById(id) {
  return loadUsers().find(u => u.id === id) || null;
}

function loadSalesForUser(uid) {
  ensureDirs();
  const result = {};
  fs.readdirSync(SALES_DIR)
    .filter(f => f.startsWith(uid + '__') && f.endsWith('.json'))
    .forEach(f => {
      const mesKey = f.slice(uid.length + 2, -5);
      try { result[mesKey] = JSON.parse(fs.readFileSync(path.join(SALES_DIR, f), 'utf8')); }
      catch (e) {}
    });
  return result;
}

function saveSalesForUser(uid, mesKey, data) {
  ensureDirs();
  fs.writeFileSync(path.join(SALES_DIR, `${uid}__${mesKey}.json`), JSON.stringify(data, null, 2));
}

function deleteSalesForUser(uid, mesKey) {
  const file = path.join(SALES_DIR, `${uid}__${mesKey}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ─── Sessões em memória ────────────────────────────────────────────────────
const sessions = {};

function createToken(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = uid;
  return token;
}

// ─── Middleware de autenticação ────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Não autenticado' });
  const uid = sessions[token];
  const user = getUserById(uid);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
  req.uid = uid;
  req.user = user;
  next();
}

function onlyAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

function adminOrGerente(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'gerente')
    return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ─── Parser v10 ───────────────────────────────────────────────────────────
function parseBR(str) {
  if (!str) return 0;
  const s = str.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

const MESES_MAP = {
  janeiro:'jan', fevereiro:'fev', março:'mar', marco:'mar', abril:'abr',
  maio:'mai', junho:'jun', julho:'jul', agosto:'ago', setembro:'set',
  outubro:'out', novembro:'nov', dezembro:'dez'
};

function detectarMes(lines) {
  for (const line of lines) {
    const m = line.toLowerCase().match(/\b(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
    if (m) return MESES_MAP[m[1]] || m[1];
    const m2 = line.match(/\b(0[1-9]|1[0-2])\/20\d{2}\b/);
    if (m2) {
      const idx = parseInt(m2[1], 10) - 1;
      return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][idx];
    }
  }
  return null;
}

function parsearLinhas(lines) {
  const mesKey = detectarMes(lines) || 'jan';
  const nomeMeses = { jan:'Janeiro', fev:'Fevereiro', mar:'Março', abr:'Abril',
    mai:'Maio', jun:'Junho', jul:'Julho', ago:'Agosto', set:'Setembro',
    out:'Outubro', nov:'Novembro', dez:'Dezembro' };

  // detectar TOTAL GERAL para fator de escala
  let resumoTotal = 0;
  for (const line of lines) {
    if (/TOTAL\s+GERAL/i.test(line)) {
      const nums = line.match(/[\d.,]+/g) || [];
      for (let i = nums.length - 1; i >= 0; i--) {
        const v = parseBR(nums[i]);
        if (v > 0) { resumoTotal = v; break; }
      }
      break;
    }
  }

  // parsing clientes
  const clientes = {};
  let totalParsed = 0;
  let pedidos = 0;

  // padrão: COD NOME ... VALOR (último número da linha)
  const reCliente = /^(\d{4,6})\s+(.+?)\s+([\d.]+,\d{2})\s*$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/TOTAL\s+GERAL|VENDAS\s+POR|RELATORIO|PERIODO|DATA|HORA|PAGINA|Page/i.test(trimmed)) continue;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(trimmed)) continue;

    // detectar pedidos: linhas com apenas número de pedido
    if (/^\d{1,6}\s+\d{1,6}$/.test(trimmed)) { pedidos++; continue; }

    const m = trimmed.match(reCliente);
    if (m) {
      const cod = m[1].padStart(5, '0');
      const nome = m[2].replace(/\s+/g, ' ').trim().toUpperCase();
      const valor = parseBR(m[3]);
      if (!clientes[cod]) clientes[cod] = { nome, total: 0 };
      else if (nome.length > clientes[cod].nome.length) clientes[cod].nome = nome;
      clientes[cod].total = Math.round((clientes[cod].total + valor) * 100) / 100;
      totalParsed = Math.round((totalParsed + valor) * 100) / 100;
      continue;
    }

    // fallback: qualquer linha com código 5 dígitos + nome + valor no fim
    const mFlex = trimmed.match(/^(\d{5})\s+(.{3,40}?)\s+([\d]{1,3}(?:\.\d{3})*,\d{2})\s*$/);
    if (mFlex) {
      const cod = mFlex[1];
      const nome = mFlex[2].replace(/\s+/g, ' ').trim().toUpperCase();
      const valor = parseBR(mFlex[3]);
      if (valor <= 0) continue;
      if (!clientes[cod]) clientes[cod] = { nome, total: 0 };
      else if (nome.length > clientes[cod].nome.length) clientes[cod].nome = nome;
      clientes[cod].total = Math.round((clientes[cod].total + valor) * 100) / 100;
      totalParsed = Math.round((totalParsed + valor) * 100) / 100;
    }
  }

  // aplicar fator de escala se TOTAL GERAL encontrado
  const scaleFactor = (resumoTotal > 0 && totalParsed > 0) ? resumoTotal / totalParsed : 1;
  const total = resumoTotal > 0 ? resumoTotal : totalParsed;

  if (Math.abs(scaleFactor - 1) > 0.01) {
    Object.values(clientes).forEach(c => {
      c.total = Math.round(c.total * scaleFactor * 100) / 100;
    });
  }

  if (!pedidos) {
    pedidos = Object.keys(clientes).length;
  }

  return {
    mesKey,
    label: (nomeMeses[mesKey] || mesKey) + ' 2026',
    total,
    pedidos,
    clientes
  };
}

// ─── Rotas ─────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Dados incompletos' });
  const user = loadUsers().find(u => u.id === usuario.toLowerCase() && u.senha === senha);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = createToken(user.id);
  res.json({ token, user: { id: user.id, nome: user.nome, role: user.role, cod: user.cod } });
});

// Logout
app.post('/api/logout', auth, (req, res) => {
  const token = req.headers['x-auth-token'];
  delete sessions[token];
  res.json({ ok: true });
});

// Me
app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, nome: u.nome, role: u.role, cod: u.cod });
});

// ─── Usuários ──────────────────────────────────────────────────────────────

// Listar usuários — admin vê todos, gerente vê vendedores
app.get('/api/users', auth, adminOrGerente, (req, res) => {
  const users = loadUsers();
  const lista = req.user.role === 'admin'
    ? users
    : users.filter(u => u.role === 'vendedor');
  res.json(lista.map(u => ({ id: u.id, nome: u.nome, role: u.role, cod: u.cod || '' })));
});

// Criar usuário — admin: qualquer role | gerente: apenas vendedor
app.post('/api/users', auth, adminOrGerente, (req, res) => {
  const { id, nome, senha, role, cod } = req.body || {};
  if (!id || !nome || !senha || !role) return res.status(400).json({ error: 'Campos obrigatórios: id, nome, senha, role' });

  // gerente só pode criar vendedor
  if (req.user.role === 'gerente' && role !== 'vendedor')
    return res.status(403).json({ error: 'Gerente só pode criar usuários do tipo vendedor' });

  const roles = ['admin', 'gerente', 'vendedor'];
  if (!roles.includes(role)) return res.status(400).json({ error: 'Role inválido' });

  const users = loadUsers();
  if (users.find(u => u.id === id)) return res.status(400).json({ error: 'Login já existe' });
  users.push({ id, nome: nome.toUpperCase(), senha, role, cod: cod || '' });
  saveUsers(users);
  res.json({ ok: true });
});

// Editar usuário — admin: qualquer | gerente: só vendedores, não pode mudar role para admin/gerente
app.put('/api/users/:uid', auth, adminOrGerente, (req, res) => {
  const { uid } = req.params;
  const { nome, senha, role, cod } = req.body || {};
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === uid);
  if (idx < 0) return res.status(404).json({ error: 'Usuário não encontrado' });

  const target = users[idx];
  if (req.user.role === 'gerente') {
    if (target.role !== 'vendedor') return res.status(403).json({ error: 'Gerente só pode editar vendedores' });
    if (role && role !== 'vendedor') return res.status(403).json({ error: 'Gerente não pode alterar role' });
  }

  if (nome) target.nome = nome.toUpperCase();
  if (senha) target.senha = senha;
  if (role && req.user.role === 'admin') target.role = role;
  if (cod !== undefined) target.cod = cod;
  saveUsers(users);
  res.json({ ok: true });
});

// Excluir usuário — admin: qualquer | gerente: só vendedores
app.delete('/api/users/:uid', auth, adminOrGerente, (req, res) => {
  const { uid } = req.params;
  if (uid === req.uid) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === uid);
  if (idx < 0) return res.status(404).json({ error: 'Usuário não encontrado' });

  const target = users[idx];
  if (req.user.role === 'gerente' && target.role !== 'vendedor')
    return res.status(403).json({ error: 'Gerente só pode excluir vendedores' });

  users.splice(idx, 1);
  saveUsers(users);
  res.json({ ok: true });
});

// ─── Vendas ────────────────────────────────────────────────────────────────

// GET /api/sales — vendedor: próprios dados | admin/gerente: todos os vendedores
app.get('/api/sales', auth, (req, res) => {
  const elev = req.user.role === 'admin' || req.user.role === 'gerente';
  if (!elev) {
    return res.json(loadSalesForUser(req.uid));
  }
  // retorna { uid: { nome, role, data: {...} } }
  const users = loadUsers();
  const result = {};
  users.forEach(u => {
    const data = loadSalesForUser(u.id);
    if (Object.keys(data).length > 0) {
      result[u.id] = { nome: u.nome, role: u.role, data };
    }
  });
  res.json(result);
});

// DELETE /api/sales/:mesKey — remove mês de um vendedor
// admin/gerente podem passar ?uid=xxx para remover de outro vendedor
app.delete('/api/sales/:mesKey', auth, (req, res) => {
  const { mesKey } = req.params;
  let targetUid = req.uid;
  const elev = req.user.role === 'admin' || req.user.role === 'gerente';
  if (elev && req.query.uid) {
    targetUid = req.query.uid;
  } else if (!elev) {
    targetUid = req.uid;
  }
  deleteSalesForUser(targetUid, mesKey);
  res.json({ ok: true });
});

// POST /api/parse-text — faz o parse das linhas e salva
// admin/gerente podem passar targetUid no body para salvar em outro vendedor
app.post('/api/parse-text', auth, (req, res) => {
  const { lines, targetUid } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ error: 'lines[] obrigatório' });

  const elev = req.user.role === 'admin' || req.user.role === 'gerente';

  // determinar UID de destino
  let saveUid = req.uid;
  if (elev && targetUid && targetUid.trim()) {
    const target = getUserById(targetUid.trim());
    if (!target) return res.status(404).json({ error: 'Vendedor não encontrado: ' + targetUid });
    saveUid = target.id;
  }

  try {
    const parsed = parsearLinhas(lines);
    saveSalesForUser(saveUid, parsed.mesKey, {
      total: parsed.total,
      pedidos: parsed.pedidos,
      label: parsed.label,
      clientes: parsed.clientes
    });
    res.json({
      ok: true,
      mesKey: parsed.mesKey,
      label: parsed.label,
      total: parsed.total,
      pedidos: parsed.pedidos,
      clientes: parsed.clientes,
      savedFor: saveUid
    });
  } catch (err) {
    console.error('parse-text error:', err);
    res.status(500).json({ error: 'Erro no parser: ' + err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta', PORT));
