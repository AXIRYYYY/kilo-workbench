// ============================================================
// 从 opencode 数据库导入项目列表 -> data\projects.json
// 独立脚本：想导入了再手动运行（双击「导入opencode项目.bat」），
// 平时完全不需要它，也不影响工作台服务。
//
// 导入规则：
//   - 取 session 表里出现过的所有去重项目目录
//   - 只保留真实存在的文件夹，黑名单路径自动跳过
//   - 已有的卡片不会被覆盖（按"路径相同"识别），只追加新项目
//   - 已导入过的项目如果数据库里已消失，不会被删除
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// 配置加载（与 server.js 同一套规则）
//   读取优先级：环境变量 > config.json > config.example.json > 内置默认值
//   本脚本只用到 opencodeImport 段；完整默认结构见 server.js 与 config.example.json。
// ============================================================
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

/** 内置默认配置（本脚本用到的部分） */
const DEFAULT_CONFIG = {
  opencodeImport: { dbPath: '', pathBlacklist: [] },
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
const DATA_FILE = path.join(ROOT, 'data', 'projects.json');
// opencode 数据库位置：环境变量 KILO_OPENCODE_DB > 配置 opencodeImport.dbPath > 当前用户目录默认位置
const DB_PATH = process.env.KILO_OPENCODE_DB
  || CFG.opencodeImport.dbPath
  || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// 黑名单：这些路径明显不是"正在用 AI 分析的数据库/项目"，导入时跳过。
// 默认空数组；个人规则请写进 config.json 的 opencodeImport.pathBlacklist，不要写死在代码里。
const PATH_BLACKLIST = CFG.opencodeImport.pathBlacklist || [];

// ---------- 工具 ----------
function toWinPath(p) { return String(p).replace(/\//g, '\\'); }
function isRealDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

// ---------- 主流程 ----------
try {
  // 1. 只读打开 opencode 数据库，取出全部会话目录并去重
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(
    'SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != \'\''
  ).all();
  db.close();
  console.log(`[读取] opencode 数据库中 共 ${rows.length} 个不重复目录`);

  // 2. 过滤：黑名单 / 不存在 / 去重
  const seen = new Set();
  const dirs = [];
  for (const row of rows) {
    let dir = toWinPath(String(row.directory).trim()).replace(/[\\]+$/, '');
    if (!dir) continue;
    const slashNorm = dir.replace(/\\/g, '/').toLowerCase();
    if (PATH_BLACKLIST.some(b => slashNorm === b.toLowerCase())) continue; // 黑名单
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    if (!isRealDir(dir)) { console.log(`[跳过] 不存在 -> ${dir}`); continue; }
    seen.add(key);
    dirs.push(dir);
  }

  // 3. 读取现有 projects.json（没有就建空结构）
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const data = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    : { cards: [] };
  data.cards = Array.isArray(data.cards) ? data.cards : [];

  // 4. 追加导入：路径相同的跳过（保留你手动维护的备注/排序/bat）
  const exists = new Set(data.cards.map(c => String(c.path).toLowerCase()));
  let added = 0;
  for (const dir of dirs) {
    if (exists.has(dir.toLowerCase())) { console.log(`[已有] ${dir}`); continue; }
    data.cards.push({
      id: 'c' + Date.now() + '-' + added,
      name: path.basename(dir) || dir,
      path: dir,
      note: '',
      order: data.cards.length + 1,
      bats: [],
    });
    added++;
    console.log(`[新增] ${dir}`);
  }

  // 5. 重新编号 order（按当前顺序），落盘
  data.cards.forEach((c, i) => c.order = i + 1);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log('----------------------------------------');
  console.log(`[完成] 本次新增 ${added} 张卡片，总计 ${data.cards.length} 张`);
  console.log(`       数据文件: data\\projects.json`);
  console.log(`       如服务正在运行，刷新网页(F5)即可看到新卡片。`);
} catch (err) {
  console.error('[失败] ' + err.message);
  process.exit(1);
}
