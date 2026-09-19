// ============================================================
// 工作台 · 本地服务（localhost:7788）
// 纯 Node 内置模块实现，无需安装任何第三方包
// 功能：
//   1. 提供 5 个接口：卡片读写 / 打开文件夹 / VS Code / 运行bat / 扫描bat
//   2. 所有卡片数据持久化在 data\projects.json（纯文本，可备份）
// 注意：opencode 项目列表导入已拆到独立脚本「从opencode导入项目.js」，
//       想导入时双击「导入opencode项目.bat」单独运行，本服务不依赖 opencode。
// ============================================================

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ============================================================
// 配置加载（模板 + 用户覆盖）
//   读取优先级：环境变量 > config.json > config.example.json > 内置默认值
//   数组项整体覆盖，不做拼接；配置损坏时只告警并回退默认值，绝不让服务起不来。
// ============================================================
const ROOT = __dirname;                                              // 工作台所在目录
const CONFIG_FILE = path.join(ROOT, 'config.json');                  // 用户配置（本地私有，不提交）
const CONFIG_EXAMPLE_FILE = path.join(ROOT, 'config.example.json');  // 配置模板（随仓库发布）

/** 内置默认配置（结构与 config.example.json 一致；用户什么都没配时用它） */
const DEFAULT_CONFIG = {
  port: 7788,
  host: '127.0.0.1',
  vscodeCommand: 'code',
  monitor: {
    dbPath: '',
    probeIntervalMs: 1000,
    snapshotDays: 7,
    recentWindowSec: 1800,
    maxSessionsPerProject: 20,
    heartbeatSec: 30,
    errorCooldownSec: 30,
    pageCacheKb: -32000,
  },
  opencodeImport: { dbPath: '', pathBlacklist: [] },
  desktopLnkImport: { sourceDirs: [], groupRules: [] },
};

/** 读 JSON；文件不存在或解析失败返回 null（只告警，不抛错） */
function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[配置] 解析失败，已忽略该文件：' + file + ' —— ' + e.message);
    return null;
  }
}

/** 深合并：对象递归合并，数组与其他值直接覆盖，null/undefined 跳过 */
function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Object.assign({}, base);
  for (const key of Object.keys(over)) {
    const v = over[key];
    if (v === undefined || v === null) continue;
    const baseVal = base[key];
    if (!Array.isArray(v) && typeof v === 'object' && baseVal
        && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      out[key] = deepMerge(baseVal, v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

const CFG = deepMerge(
  deepMerge(DEFAULT_CONFIG, readJsonSafe(CONFIG_EXAMPLE_FILE) || {}),
  readJsonSafe(CONFIG_FILE) || {}
);

// ---------- 配置 ----------
const PORT = CFG.port;                               // 服务端口（config.json 可改）
const HOST = CFG.host;                               // 监听地址：默认仅本机回环，勿改 0.0.0.0
const DATA_FILE = path.join(ROOT, 'data', 'projects.json'); // 卡片数据文件
const PUBLIC_DIR = path.join(ROOT, 'public');        // 网页目录

// ---------- 工具函数 ----------

/** 判断路径真实存在且是一个文件夹 */
function isRealDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** 路径安全校验：防止把不相干的路径/文件塞给系统命令 */
function assertSafeDir(p) {
  if (!p || typeof p !== 'string') throw new Error('缺少 path 参数');
  if (!isRealDir(p)) throw new Error('文件夹不存在: ' + p);
}

// ---------- 读写卡片数据 ----------

/** 读卡片数据；用户自己的 projects.json 优先，其次示例卡片，最后空列表 */
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  // 首次运行：没有用户数据时，展示示例卡片（只读展示，不写盘）
  const exampleFile = path.join(ROOT, 'data', 'projects.example.json');
  if (fs.existsSync(exampleFile)) {
    console.log('[提示] 未找到 data\\projects.json，先展示 data\\projects.example.json 里的示例卡片；');
    console.log('       在网页上编辑保存后，会自动生成属于你自己的 data\\projects.json。');
    return JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
  }
  console.log('[提示] data\\projects.json 不存在，先以空列表启动。');
  console.log('       想从 opencode 导入项目，请双击「导入opencode项目.bat」；');
  console.log('       或打开网页点「➕ 添加卡片」手动添加。');
  return { cards: [] };
}

/** 保存卡片数据（前端整体提交，最简单可靠） */
function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- 动作：打开文件夹 / VS Code / 运行bat / 扫描bat ----------

/** 用资源管理器打开文件夹（弹出独立窗口，不阻塞） */
function openFolder(p) {
  assertSafeDir(p);
  // explorer.exe 用反斜杠路径最稳
  /* 经 PowerShell Start-Process 拉起。踩坑记录：
     - explorer.exe 直拉：可见但不激活，窗口压在浏览器后面；
     - cmd /c start：从隐藏控制台启动会继承 SW_HIDE，窗口完全不可见；
     - Start-Process（UseShellExecute+正常 WindowStyle）从隐藏进程拉起仍可见并激活 */
  /* 经反复实测，ShellExecute/激活补丁在隐藏控制台环境下副作用大（开又关、抢占已有
     窗口），用户拍板回退最朴素方案：explorer.exe 直拉。窗口可能落在后面（Alt+Tab
     可见），但绝不会有关闭重开/闪烁副作用 */
  spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * 用默认浏览器打开本地 html 文件（卡片上的"网页直链"按钮用）。
 * 安全校验：
 *   1. dir 是真实文件夹
 *   2. file 必须在该 dir 内部（拒绝 ..\ 穿越）
 *   3. 必须是 .html 文件且真实存在
 * 网页直链只放公开页面用；http 页面无法直接点 file:// 链接（浏览器安全限制），所以走后端。
 */
function openLocalFile(dir, file) {
  assertSafeDir(dir);
  if (!file || typeof file !== 'string' || !file.toLowerCase().endsWith('.html')) {
    throw new Error('只能打开 .html 文件');
  }
  const full = path.resolve(dir, file.replace(/\//g, '\\'));
  const base = path.resolve(dir);
  // 防路径穿越：解析后的完整路径必须还在项目目录里
  if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
    throw new Error('文件不在项目目录内');
  }
  if (!fs.existsSync(full)) throw new Error('html 不存在: ' + full);

  // start 默认浏览器打开（start 第一个引号参数=窗口标题，所以开头放空标题）
  spawn('cmd.exe', ['/c', 'start', '""', '"' + full + '"'], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
}

/** 用 VS Code 打开文件夹（code.cmd 在 PATH 里） */
function openVscode(p) {
  assertSafeDir(p);
  spawn('cmd.exe', ['/c', CFG.vscodeCommand || 'code', p], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * 扫描指定目录下的所有 *.bat 文件，返回文件名数组。
 * 只扫第一层，不进子文件夹（够用且快）。
 */
function scanBats(p) {
  assertSafeDir(p);
  return fs.readdirSync(p)
    .filter(f => f.toLowerCase().endsWith('.bat'))
    .sort();
}

/**
 * 运行某个 bat。安全校验：
 *   1. dir 必须是真实存在的文件夹
 *   2. file 必须确实是该目录下的 .bat 文件（防止任意命令执行）
 * 用 cwd=dir 方式启动，bat 里的相对路径以项目目录为基准，行为和双击一致。
 */
function runBat(dir, file) {
  assertSafeDir(dir);
  if (!file || typeof file !== 'string' || !file.toLowerCase().endsWith('.bat')) {
    throw new Error('只能运行 .bat 文件');
  }
  const full = path.join(dir, file);
  // 确认 file 就在 dir 里，防止 "..\..\xx.bat" 这类路径穿越
  if (path.dirname(full).toLowerCase() !== path.resolve(dir).toLowerCase()) {
    throw new Error('非法路径');
  }
  if (!fs.existsSync(full)) throw new Error('bat 不存在: ' + full);

  // start 命令正确语法: start "窗口标题" /D 目录 命令
  // 空标题 "" 后紧跟 /D，最后才是 bat 文件名；路径用引号包住防空格断裂
  spawn('cmd.exe', ['/c', 'start', '""', '/D', '"' + dir + '"', file], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true, // 自己控制引号，避免 Node 再转一层
  }).unref();
}

// ============================================================
// 监控台模块（已并入本服务：只读 kilo.db，零第三方依赖）
// 设计要点（沿用原 Python 版约定，勿随意简化）：
//   1. 只读打开数据库 + PRAGMA query_only 双保险，物理上无法写库
//   2. 空闲时每秒 1 次 PRAGMA data_version —— 只读内存映射的 WAL 头，
//      约 0.05ms、零数据页 IO；只有 Kilo 真的写库才重算快照
//   3. 浏览器走 SSE 长连接：无变化一字节不发；连接断了才降级为带 ver 短路的轮询
// ============================================================

// ---------- 监控台配置（默认值集中在 config.example.json 的 monitor 段，改配置即可） ----------
// 数据源优先级：环境变量 KILO_MON_DB > 配置 monitor.dbPath > 当前用户目录下的 Kilo 库
const MON_DB = process.env.KILO_MON_DB
  || CFG.monitor.dbPath
  || path.join(os.homedir(), '.local', 'share', 'kilo', 'kilo.db');
const MON_PROBE_MS = CFG.monitor.probeIntervalMs;               // data_version 探测间隔（毫秒）
const MON_SNAPSHOT_DAYS = CFG.monitor.snapshotDays;             // 快照只覆盖最近 N 天有活动的会话
const MON_RECENT_SEC = CFG.monitor.recentWindowSec;             // lastRole 只查最近 30 分钟活跃的会话（不读历史大 blob）
const MON_MAX_PER_PROJECT = CFG.monitor.maxSessionsPerProject;  // 每个项目最多返回的会话条数
const MON_HEARTBEAT_SEC = CFG.monitor.heartbeatSec;             // SSE 心跳间隔（秒），防中间层掐断空闲连接
const MON_ERR_COOLDOWN_SEC = CFG.monitor.errorCooldownSec;      // 快照构建失败后的重试冷却（秒），避免疯狂重试
const MON_PAGE_CACHE_KB = CFG.monitor.pageCacheKb;              // SQLite 页缓存上限（负数 = KiB）

// node:sqlite 是 Node 内置模块（v22.5+）；拿不到时监控台降级为"错误快照"，
// 工作台其余功能完全不受影响。
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('[监控台] node:sqlite 不可用，监控视图将显示错误提示：', e.message);
}

/** 监控台共享状态（单线程事件循环内访问，无需锁） */
const monState = {
  db: null,          // 唯一一条只读长连接（全程复用，禁止每请求连库）
  dvStmt: null,      // PRAGMA data_version 的预编译语句
  lastDv: null,      // 上次探测到的 data_version
  ver: 0,            // 快照版本号（每次重算 +1）
  snapshot: null,    // 最近一次快照（内存对象，几百 KB 上限）
  subs: new Set(),   // SSE 订阅者集合（每个浏览器连接一项）
  probeTimer: null,
  lastErrAt: 0,      // 上次快照失败时间（配合冷却）
};

const SQL_MON_SESSIONS =
  'SELECT id, directory, title, time_updated, cost, tokens_input + tokens_output AS tokens' +
  ' FROM session WHERE time_updated > ? ORDER BY time_updated DESC';
const SQL_MON_LAST_ROLE =
  "SELECT json_extract(data,'$.role') AS role FROM message" +
  " WHERE session_id = ? AND json_extract(data,'$.parentID') IS NULL" +
  ' ORDER BY time_created DESC, id DESC LIMIT 1';

/**
 * 打开只读连接。
 * readOnly 失败时回退普通打开（但立刻 query_only=1 罩住，仍然写不进去）。
 */
function openMonConn() {
  if (!DatabaseSync) throw new Error('node:sqlite 不可用');
  let db;
  try {
    db = new DatabaseSync(MON_DB, { readOnly: true });
  } catch (e) {
    console.error('[监控台] 只读打开失败，回退普通打开：', e.message);
    db = new DatabaseSync(MON_DB);
  }
  db.exec('PRAGMA query_only = 1');       // 双保险：即使代码有 bug 也物理上无法写库
  db.exec('PRAGMA busy_timeout = 2000');  // Kilo 正在写库时最多等 2 秒
  db.exec('PRAGMA cache_size = ' + MON_PAGE_CACHE_KB);  // 页缓存上限（负数 = KiB，默认 32MB）
  monState.db = db;
  monState.dvStmt = db.prepare('PRAGMA data_version');
  return db;
}

/** 连接异常时重建一条（WAL 只读连接损坏极罕见，兜底用） */
function reopenMonConn() {
  try { if (monState.db) monState.db.close(); } catch (_) {}
  monState.db = null;
  monState.dvStmt = null;
  try { openMonConn(); } catch (e) { console.error('[监控台] 重连失败：', e.message); }
}

/**
 * 重算快照。语义与工作台监控台前端一一对应：
 *   {now, ver, projects:[{directory, displayName, lastActivity, sessions:[...]}]}
 * 失败（如 Kilo 升级改了库结构）→ 产出 error 快照并在冷却期内不再重试。
 */
function buildSnapshot() {
  const nowMs = Date.now();
  if (monState.snapshot && monState.snapshot.error &&
      (Date.now() - monState.lastErrAt) < MON_ERR_COOLDOWN_SEC * 1000) {
    return; // 冷却中
  }
  try {
    if (!monState.db) openMonConn();
    const weekAgo = nowMs - MON_SNAPSHOT_DAYS * 86400 * 1000;
    const recentCut = nowMs - MON_RECENT_SEC * 1000;

    const rows = monState.db.prepare(SQL_MON_SESSIONS).all(weekAgo);

    // lastRole：只查最近 30 分钟活跃的会话（老会话状态恒为"空闲"，无需读 blob）
    const roleStmt = monState.db.prepare(SQL_MON_LAST_ROLE);
    const roles = {};
    for (const r of rows) {
      if (r.time_updated <= recentCut) continue;
      const row = roleStmt.get(r.id);
      if (row && row.role) roles[r.id] = row.role;
    }

    // 按 directory 分组（与 git 无关，非 git 项目同样有 directory）
    const projects = new Map();
    for (const r of rows) {
      const dir = r.directory;
      let p = projects.get(dir);
      if (!p) {
        const name = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
        p = { directory: dir, displayName: name, lastActivity: 0, sessions: [] };
        projects.set(dir, p);
      }
      if (p.sessions.length >= MON_MAX_PER_PROJECT) continue;
      p.sessions.push({
        id: r.id,
        title: r.title,
        timeUpdated: r.time_updated,
        cost: Math.round((r.cost || 0) * 10000) / 10000,
        tokens: Math.round(r.tokens || 0),
        lastRole: roles[r.id] || '',
      });
      if (r.time_updated > p.lastActivity) p.lastActivity = r.time_updated;
    }

    monState.ver += 1;
    const snap = {
      now: nowMs,
      ver: monState.ver,
      projects: Array.from(projects.values()).sort((a, b) => b.lastActivity - a.lastActivity),
    };
    monState.snapshot = snap;
    pushToSubs(snap);
    console.log('[监控台] 快照已更新 -> v' + snap.ver + '，' + snap.projects.length + ' 个项目');
  } catch (e) {
    monState.lastErrAt = Date.now();
    const isSchema = /no such table|no such column|unable to open|SQLITE/i.test(e.message || '');
    const snap = {
      now: nowMs,
      ver: monState.ver,
      error: isSchema ? 'db_schema_changed' : 'sqlite_unavailable',
      detail: String(e.message || e).slice(0, 200),
    };
    monState.snapshot = snap;
    pushToSubs(snap);
    console.error('[监控台] 快照构建失败：', e.message);
  }
}

/** 把新快照推给所有 SSE 订阅者；写失败的连接顺手清掉 */
function pushToSubs(snap) {
  const payload = 'data: ' + JSON.stringify(snap) + '\n\n';
  for (const sub of Array.from(monState.subs)) {
    try {
      sub.res.write(payload);
    } catch (_) {
      cleanupSub(sub);
    }
  }
}

/** 后台探测：每秒 1 次 data_version，变了才重算快照（空闲时零数据页 IO） */
function startMonProbe() {
  if (monState.probeTimer) return;
  monState.probeTimer = setInterval(() => {
    try {
      if (!monState.dvStmt) return;
      const dv = monState.dvStmt.get().data_version;
      if (dv !== monState.lastDv) {
        monState.lastDv = dv;
        buildSnapshot();
      }
    } catch (e) {
      console.error('[监控台] 探测失败，尝试重连：', e.message);
      reopenMonConn();
    }
  }, MON_PROBE_MS);
  if (monState.probeTimer.unref) monState.probeTimer.unref(); // 不因为它而拖住进程退出
}

/** 停止监控台（关闭服务时调用）：清定时器 + 关连接 */
function stopMon() {
  if (monState.probeTimer) { clearInterval(monState.probeTimer); monState.probeTimer = null; }
  for (const sub of Array.from(monState.subs)) cleanupSub(sub);
  try { if (monState.db) monState.db.close(); } catch (_) {}
  monState.db = null;
  monState.dvStmt = null;
}

/** SSE 订阅清理（幂等） */
function cleanupSub(sub) {
  if (sub.timer) { clearInterval(sub.timer); sub.timer = null; }
  monState.subs.delete(sub);
}

/** SSE 主通道：连接挂起，变化才推，心跳防断连 */
function handleMonEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  const sub = { res, timer: null };
  monState.subs.add(sub);
  // 连接建立立即推当前快照（页面无需等下一次变化）
  if (monState.snapshot) {
    try { res.write('data: ' + JSON.stringify(monState.snapshot) + '\n\n'); } catch (_) {}
  }
  sub.timer = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { cleanupSub(sub); }
  }, MON_HEARTBEAT_SEC * 1000);
  if (sub.timer.unref) sub.timer.unref();
  req.on('close', () => cleanupSub(sub));
  res.on('close', () => cleanupSub(sub));
  res.on('error', () => cleanupSub(sub));
  // 注意：这里不调用 res.end()，连接保持挂起直到浏览器关闭
}

/** 兜底轮询：ver 相同就只回一个 {"changed":false}（毫秒级短路），否则回全量快照 */
function handleMonSessions(res, ver) {
  const snap = monState.snapshot;
  if (!snap) return sendJson(res, 200, { changed: false });
  if (ver === snap.ver && !snap.error) return sendJson(res, 200, { changed: false, ver: snap.ver });
  return sendJson(res, 200, snap);
}

// ---------- HTTP 服务 ----------

/** 读请求体里的 JSON（小数据量，够用） */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('请求过大')); // 1MB 上限
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 统一的 JSON 响应 */
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  try {
    // ---- 首页：返回 public\index.html ----
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // ---- GET /api/cards：读取全部卡片 ----
    if (req.method === 'GET' && urlPath === '/api/cards') {
      return sendJson(res, 200, loadData());
    }

    // ---- POST /api/cards：保存整份卡片数据 ----
    if (req.method === 'POST' && urlPath === '/api/cards') {
      const data = await readJson(req);
      if (!data || !Array.isArray(data.cards)) throw new Error('数据格式不对');
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/open-folder：资源管理器打开文件夹 ----
    if (req.method === 'POST' && urlPath === '/api/open-folder') {
      const { path: p } = await readJson(req);
      openFolder(p);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/open-vscode：VS Code 打开文件夹 ----
    if (req.method === 'POST' && urlPath === '/api/open-vscode') {
      const { path: p } = await readJson(req);
      openVscode(p);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/scan-bats：扫描目录下的 bat ----
    if (req.method === 'POST' && urlPath === '/api/scan-bats') {
      const { path: p } = await readJson(req);
      return sendJson(res, 200, { ok: true, bats: scanBats(p) });
    }

    // ---- POST /api/run-bat：运行指定目录下的 bat ----
    if (req.method === 'POST' && urlPath === '/api/run-bat') {
      const { dir, file } = await readJson(req);
      runBat(dir, file);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/open-file：浏览器打开项目内的本地 html ----
    if (req.method === 'POST' && urlPath === '/api/open-file') {
      const { dir, file } = await readJson(req);
      openLocalFile(dir, file);
      return sendJson(res, 200, { ok: true });
    }

    // ---- GET /api/status：服务在线状态（网页状态灯用） ----
    if (req.method === 'GET' && urlPath === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
      });
    }

    // ---- GET /api/monitor/events：监控台 SSE 主通道（有变化才推，无变化零流量） ----
    if (req.method === 'GET' && urlPath === '/api/monitor/events') {
      return handleMonEvents(req, res);
    }

    // ---- GET /api/monitor/sessions?ver=N：监控台兜底轮询（SSE 断开时前端自动降级） ----
    if (req.method === 'GET' && urlPath === '/api/monitor/sessions') {
      const verParam = new URL(req.url, 'http://127.0.0.1').searchParams.get('ver');
      return handleMonSessions(res, parseInt(verParam || '0', 10) || 0);
    }

    // ---- POST /api/shutdown：从网页关闭服务 ----
    if (req.method === 'POST' && urlPath === '/api/shutdown') {
      sendJson(res, 200, { ok: true, message: '工作台与监控台服务将在1秒后关闭' });
      // 先把响应发回浏览器（上面 sendJson 同步完成），半秒后清理并退出进程。
      // 监控台与工作台现在是同一个进程，所以这里退出 = 两个都关。
      console.log('[关闭] 收到网页关闭请求，工作台与监控台（同一进程）即将退出');
      setTimeout(() => {
        try { stopMon(); } catch (_) {}
        process.exit(0);
      }, 500);
      return;
    }

    // ---- 其余路径：404 ----
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    console.error('[错误]', err.message);
    // 页面请求出错返回纯文本，接口请求出错返回 JSON，前端好提示
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

// ---------- 启动 ----------
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[提示] 7788 端口已被占用——工作台服务已经在运行了，本窗口即将退出。');
    console.log('       （可以直接用浏览器访问 http://localhost:7788）');
  } else {
    console.error('[启动失败]', err.message);
  }
  process.exit(0); // 退出码 0，避免报"异常退出"吓到用户
});

// ---------- 启动监控台（并入的后端；失败绝不影响工作台本体） ----------
try {
  openMonConn();
  monState.lastDv = monState.dvStmt.get().data_version; // 记录初始基线，避免首秒空跑一次快照
  startMonProbe();
} catch (e) {
  console.error('[监控台] 初始化失败（工作台本体不受影响）：', e.message);
}
buildSnapshot(); // 初始快照：服务就绪即已有数据；失败时内部会产出错误快照供前端显示原因

server.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log(' 工作台 · 本地服务已启动（监控台已并入，同一进程）');
  console.log(' 地址: http://localhost:' + PORT);
  console.log(' 数据: data\\projects.json');
  console.log(' 监控台数据源(只读): ' + MON_DB);
  console.log(' 关闭服务: 直接关掉这个窗口，或用网页上的「⏹ 关闭服务」');
  console.log('========================================');
});
