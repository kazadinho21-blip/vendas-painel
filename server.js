const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ---- Persistencia ----
const DATA_DIR   = path.join(__dirname, 'data');
const SALES_DIR  = path.join(DATA_DIR, 'sales');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
  if (!fs.existsSync(SALES_DIR)) fs.mkdirSync(SALES_DIR, { recursive: true });
}

var DEFAULT_USERS = [
  { id: 'agner',    nome: 'AGNER',    senha: 'douratubos2026', role: 'admin',    cod: '0065' },
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
  return loadUsers().find(function(u){ return u.id === id; }) || null;
}

function loadSalesForUser(uid) {
  ensureDirs();
  var result = {};
  fs.readdirSync(SALES_DIR)
    .filter(function(f){ return f.startsWith(uid + '__') && f.endsWith('.json'); })
    .forEach(function(f) {
      var mesKey = f.slice(uid.length + 2, -5);
      try { result[mesKey] = JSON.parse(fs.readFileSync(path.join(SALES_DIR, f), 'utf8')); }
      catch(e) {}
    });
  return result;
}

function saveSalesForUser(uid, mesKey, data) {
  ensureDirs();
  fs.writeFileSync(path.join(SALES_DIR, uid + '__' + mesKey + '.json'), JSON.stringify(data, null, 2));
}

function deleteSalesForUser(uid, mesKey) {
  var file = path.join(SALES_DIR, uid + '__' + mesKey + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ---- Sessoes em memoria ----
var sessions = {};

function createToken(uid) {
  var token = crypto.randomBytes(32).toString('hex');
  sessions[token] = uid;
  return token;
}

// ---- Auth middleware ----
function auth(req, res, next) {
  var token = req.headers['x-auth-token'];
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Nao autenticado' });
  var uid = sessions[token];
  var user = getUserById(uid);
  if (!user) return res.status(401).json({ error: 'Usuario nao encontrado' });
  req.uid  = uid;
  req.user = user;
  next();
}

function adminOrGerente(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'gerente')
    return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ---- Parser v11 ----
function parseBR(str) {
  if (!str) return 0;
  var s = String(str).replace(/\./g, '').replace(',', '.');
  // remover tudo que nao seja digito, ponto ou sinal negativo
  s = s.replace(/[^0-9.\-]/g, '');
  var v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

var MESES_KEY   = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
var MESES_NOMES = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function parsearLinhas(lines) {

  // 1. Detectar mes pelo cabecalho: "Periodo 01/01/2026 a 31/01/2026"
  var mesKey = null;
  for (var i = 0; i < lines.length; i++) {
    var mPeriodo = lines[i].match(/[Pp]eriodo\s+\d{2}\/(\d{2})\/\d{4}/);
    if (mPeriodo) {
      var idx = parseInt(mPeriodo[1], 10) - 1;
      if (idx >= 0 && idx < 12) mesKey = MESES_KEY[idx];
      break;
    }
  }
  if (!mesKey) {
    // fallback: nome do mes no texto
    for (var i = 0; i < lines.length; i++) {
      var ll = lines[i].toLowerCase();
      for (var k = 0; k < MESES_NOMES.length; k++) {
        if (ll.indexOf(MESES_NOMES[k].toLowerCase()) !== -1) {
          mesKey = MESES_KEY[k];
          break;
        }
      }
      if (mesKey) break;
    }
  }
  if (!mesKey) mesKey = 'jan';

  // 2. Total Geral do resumo do PDF
  // Linha: "Total GERAL 19.175,01 17,55 336.524,50 336.524,50 0,00 0,00"
  // Posicoes: QTD  PRECO_MEDIO  TOTAL_GERAL  PECA  SERV  COM
  var resumoTotal = 0;
  var numsRe = /([-\d.]+,\d+)/g;
  for (var i = 0; i < lines.length; i++) {
    if (/^Total\s+GERAL\s/i.test(lines[i])) {
      var nums = [];
      var m;
      numsRe.lastIndex = 0;
      while ((m = numsRe.exec(lines[i])) !== null) nums.push(parseBR(m[1]));
      if (nums.length >= 3) resumoTotal = nums[2];
      else if (nums.length === 2) resumoTotal = nums[1];
      break;
    }
  }

  // 3. Parser linha a linha de transacoes
  // Formato por linha:
  //   DD/MM/YYYY  PEDIDO  [NOTA]  CFOP  CONDICAO  CODCLI(5dig)  NOME  CPF/CNPJ  [cpf]  CIDADE  UF  QTDE  PRECO  TOTAL  PECA  SERV  COM
  //
  // Regra critica: o codigo do cliente tem EXATAMENTE 5 digitos (isolado).
  // Pedido e Nota tem 7 digitos, CFOP tem 4 digitos.
  // Usamos lookahead/lookbehind para nao pegar substring de numeros maiores.

  var DATE_RE   = /^\d{2}\/\d{2}\/\d{4}\s/;
  // ultimos 6 numeros brasileiros na linha
  var NUMS6_RE  = /([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+([-\d.]+,\d+)\s+([-\d.]+,\d+)\s*$/;
  // codigo cliente: exatamente 5 digitos, nao precedido nem seguido de digito
  var CLIENT_RE = /(?:^|(?<=\s))(\d{5})(?=\s)(.+?)\s+CPF\/CNPJ/;

  var clientes = {};
  var totalParsed = 0;
  var pedidosSet = {};
  var ok = 0, err = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!DATE_RE.test(line)) continue;

    var numsMatch = NUMS6_RE.exec(line);
    if (!numsMatch) { err++; continue; }

    var totalTx = parseBR(numsMatch[3]); // 3o numero = TOTAL da transacao

    var cliMatch = CLIENT_RE.exec(line);
    if (!cliMatch) { err++; continue; }

    var cod  = cliMatch[1];
    var nome = cliMatch[2].trim();

    // pedido = 2o campo da linha
    var partes = line.split(/\s+/);
    if (partes.length > 1) pedidosSet[partes[1]] = 1;

    if (!clientes[cod]) {
      clientes[cod] = { nome: nome, total: 0 };
    } else if (nome.length > clientes[cod].nome.length) {
      clientes[cod].nome = nome;
    }
    clientes[cod].total = Math.round((clientes[cod].total + totalTx) * 100) / 100;
    totalParsed = Math.round((totalParsed + totalTx) * 100) / 100;
    ok++;
  }

  // 4. Fator de escala se houver diferenca residual de arredondamento
  var total = resumoTotal > 0 ? resumoTotal : totalParsed;
  if (resumoTotal > 0 && totalParsed !== 0 && Math.abs(resumoTotal - totalParsed) > 0.5) {
    var factor = resumoTotal / totalParsed;
    var cods = Object.keys(clientes);
    for (var j = 0; j < cods.length; j++) {
      clientes[cods[j]].total = Math.round(clientes[cods[j]].total * factor * 100) / 100;
    }
  }

  var pedidosCount = Object.keys(pedidosSet).length;
  console.log('[parser] mes=' + mesKey + ' clientes=' + Object.keys(clientes).length +
              ' pedidos=' + pedidosCount + ' total=' + total + ' ok=' + ok + ' err=' + err);

  return {
    mesKey:   mesKey,
    label:    MESES_NOMES[MESES_KEY.indexOf(mesKey)] + ' 2026',
    total:    total,
    pedidos:  pedidosCount,
    clientes: clientes
  };
}

// ---- Rotas ----

app.post('/api/login', function(req, res) {
  var usuario = (req.body || {}).usuario;
  var senha   = (req.body || {}).senha;
  if (!usuario || !senha) return res.status(400).json({ error: 'Dados incompletos' });
  var user = loadUsers().find(function(u){ return u.id === usuario.toLowerCase() && u.senha === senha; });
  if (!user) return res.status(401).json({ error: 'Usuario ou senha incorretos' });
  var token = createToken(user.id);
  res.json({ token: token, user: { id: user.id, nome: user.nome, role: user.role, cod: user.cod } });
});

app.post('/api/logout', auth, function(req, res) {
  delete sessions[req.headers['x-auth-token']];
  res.json({ ok: true });
});

app.get('/api/me', auth, function(req, res) {
  var u = req.user;
  res.json({ id: u.id, nome: u.nome, role: u.role, cod: u.cod });
});

// -- Usuarios --

app.get('/api/users', auth, adminOrGerente, function(req, res) {
  var all = loadUsers();
  var lista = req.user.role === 'admin' ? all : all.filter(function(u){ return u.role === 'vendedor'; });
  res.json(lista.map(function(u){ return { id: u.id, nome: u.nome, role: u.role, cod: u.cod || '' }; }));
});

app.post('/api/users', auth, adminOrGerente, function(req, res) {
  var b = req.body || {};
  var id = b.id, nome = b.nome, senha = b.senha, role = b.role, cod = b.cod;
  if (!id || !nome || !senha || !role)
    return res.status(400).json({ error: 'Campos obrigatorios: id, nome, senha, role' });
  if (req.user.role === 'gerente' && role !== 'vendedor')
    return res.status(403).json({ error: 'Gerente so pode criar vendedores' });
  if (['admin','gerente','vendedor'].indexOf(role) < 0)
    return res.status(400).json({ error: 'Role invalido' });
  var users = loadUsers();
  if (users.find(function(u){ return u.id === id; }))
    return res.status(400).json({ error: 'Login ja existe' });
  users.push({ id: id, nome: nome.toUpperCase(), senha: senha, role: role, cod: cod || '' });
  saveUsers(users);
  res.json({ ok: true });
});

app.put('/api/users/:uid', auth, adminOrGerente, function(req, res) {
  var uid = req.params.uid;
  var b = req.body || {};
  var users = loadUsers();
  var idx = -1;
  for (var i = 0; i < users.length; i++) { if (users[i].id === uid) { idx = i; break; } }
  if (idx < 0) return res.status(404).json({ error: 'Usuario nao encontrado' });
  var target = users[idx];
  if (req.user.role === 'gerente') {
    if (target.role !== 'vendedor') return res.status(403).json({ error: 'Gerente so pode editar vendedores' });
    if (b.role && b.role !== 'vendedor') return res.status(403).json({ error: 'Gerente nao pode alterar role' });
  }
  if (b.nome)  target.nome  = b.nome.toUpperCase();
  if (b.senha) target.senha = b.senha;
  if (b.role && req.user.role === 'admin') target.role = b.role;
  if (b.cod !== undefined) target.cod = b.cod;
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/users/:uid', auth, adminOrGerente, function(req, res) {
  var uid = req.params.uid;
  if (uid === req.uid) return res.status(400).json({ error: 'Nao pode excluir a si mesmo' });
  var users = loadUsers();
  var idx = -1;
  for (var i = 0; i < users.length; i++) { if (users[i].id === uid) { idx = i; break; } }
  if (idx < 0) return res.status(404).json({ error: 'Usuario nao encontrado' });
  if (req.user.role === 'gerente' && users[idx].role !== 'vendedor')
    return res.status(403).json({ error: 'Gerente so pode excluir vendedores' });
  users.splice(idx, 1);
  saveUsers(users);
  res.json({ ok: true });
});

// -- Vendas --

app.get('/api/sales', auth, function(req, res) {
  var elev = req.user.role === 'admin' || req.user.role === 'gerente';
  if (!elev) return res.json(loadSalesForUser(req.uid));
  var users = loadUsers();
  var result = {};
  users.forEach(function(u) {
    var data = loadSalesForUser(u.id);
    if (Object.keys(data).length > 0)
      result[u.id] = { nome: u.nome, role: u.role, data: data };
  });
  res.json(result);
});

app.delete('/api/sales/:mesKey', auth, function(req, res) {
  var elev = req.user.role === 'admin' || req.user.role === 'gerente';
  var targetUid = (elev && req.query.uid) ? req.query.uid : req.uid;
  deleteSalesForUser(targetUid, req.params.mesKey);
  res.json({ ok: true });
});

app.post('/api/parse-text', auth, function(req, res) {
  var body      = req.body || {};
  var lines     = body.lines;
  var targetUid = body.targetUid;

  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ error: 'lines[] obrigatorio' });

  var elev = req.user.role === 'admin' || req.user.role === 'gerente';
  var saveUid = req.uid;

  if (elev && targetUid && targetUid.trim()) {
    var target = getUserById(targetUid.trim());
    if (!target) return res.status(404).json({ error: 'Vendedor nao encontrado: ' + targetUid });
    saveUid = target.id;
  }

  try {
    var parsed = parsearLinhas(lines);
    saveSalesForUser(saveUid, parsed.mesKey, {
      total:    parsed.total,
      pedidos:  parsed.pedidos,
      label:    parsed.label,
      clientes: parsed.clientes
    });
    res.json({
      ok:       true,
      mesKey:   parsed.mesKey,
      label:    parsed.label,
      total:    parsed.total,
      pedidos:  parsed.pedidos,
      clientes: parsed.clientes,
      savedFor: saveUid
    });
  } catch(err) {
    console.error('parse-text error:', err);
    res.status(500).json({ error: 'Erro no parser: ' + err.message });
  }
});

// ---- Start ----
var PORT = process.env.PORT || 3000;
app.listen(PORT, function(){ console.log('Servidor na porta ' + PORT); });
