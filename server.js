const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = 'admin123'; // 后台密码，你可以改

// 初始化数据文件
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    keys: {},
    version: { latest: '2.0.0', url: '', note: '最新版本' }
  }, null, 2));
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 生成随机卡密
function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) result += '-';
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// 简单的鉴权
function checkAdminAuth(req) {
  const auth = req.headers.authorization;
  return auth === 'Bearer ' + ADMIN_PASSWORD;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ========== API 接口 ==========

  // 卡密验证（客户端用）
  if (pathname === '/api/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { key, machineId } = JSON.parse(body || '{}');
      const data = readData();
      
      const keyData = data.keys[key];
      if (!keyData) {
        res.end(JSON.stringify({ success: false, reason: '卡密不存在' }));
        return;
      }

      // 检查是否过期
      if (keyData.expire && Date.now() > keyData.expire) {
        res.end(JSON.stringify({ success: false, reason: '卡密已过期' }));
        return;
      }

      // 检查机器码绑定
      if (keyData.machineId && keyData.machineId !== machineId) {
        res.end(JSON.stringify({ success: false, reason: '卡密已绑定其他电脑' }));
        return;
      }

      // 第一次激活，绑定机器码
      if (!keyData.machineId) {
        keyData.machineId = machineId;
        keyData.activateTime = new Date().toISOString();
        writeData(data);
      }

      res.end(JSON.stringify({
        success: true,
        expire: keyData.expire,
        type: keyData.type
      }));
    });
  }

  // 版本检查（自动更新用）
  else if (pathname === '/api/version' && req.method === 'GET') {
    const data = readData();
    res.end(JSON.stringify({
      success: true,
      latest: data.version.latest,
      url: data.version.url,
      note: data.version.note
    }));
  }

  // ========== 后台管理 API ==========

  // 生成卡密
  else if (pathname === '/api/admin/generate' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, reason: '未授权' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { type = '永久', note = '' } = JSON.parse(body || '{}');
      const data = readData();
      
      const key = generateKey();
      let expire = null;
      if (type !== '永久') {
        const days = parseInt(type);
        expire = Date.now() + days * 24 * 60 * 60 * 1000;
      }

      data.keys[key] = {
        type,
        expire,
        note,
        machineId: null,
        createTime: new Date().toISOString()
      };
      writeData(data);

      res.end(JSON.stringify({ success: true, key, data: data.keys[key] }));
    });
  }

  // 获取卡密列表
  else if (pathname === '/api/admin/list' && req.method === 'GET') {
    if (!checkAdminAuth(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, reason: '未授权' }));
      return;
    }
    const data = readData();
    res.end(JSON.stringify({ success: true, keys: data.keys }));
  }

  // 解绑机器码
  else if (pathname === '/api/admin/unbind' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, reason: '未授权' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { key } = JSON.parse(body || '{}');
      const data = readData();
      if (data.keys[key]) {
        data.keys[key].machineId = null;
        writeData(data);
        res.end(JSON.stringify({ success: true }));
      } else {
        res.end(JSON.stringify({ success: false, reason: '卡密不存在' }));
      }
    });
  }

  // 更新版本信息
  else if (pathname === '/api/admin/version' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, reason: '未授权' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { latest, url, note } = JSON.parse(body || '{}');
      const data = readData();
      data.version = { latest, url, note };
      writeData(data);
      res.end(JSON.stringify({ success: true }));
    });
  }

  // 静态文件（后台页面）
  else {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'admin.html' : pathname);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(data);
    });
  }
});

server.listen(PORT, () => {
  console.log(`服务器启动: http://localhost:${PORT}`);
  console.log(`后台地址: http://localhost:${PORT}/admin.html`);
});
