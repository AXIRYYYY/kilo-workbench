// ============================================================
// 从桌面快捷方式导入 -> data\projects.json
// 独立脚本：双击「导入桌面快捷方式.bat」运行，平时不影响工作台服务。
//
// 来源目录与分组规则都从 config.json 读取（键名：desktopLnkImport.sourceDirs / desktopLnkImport.groupRules）。
//
// 导入规则（按 .lnk 指向的目标自动分类）：
//   - 指向【文件夹】     -> 新建一张卡片（名字取快捷方式名，去掉「 - 快捷方式」等尾缀）
//   - 指向【.bat 文件】  -> 挂到 bat 所在文件夹那张卡片的 bats 列表（没有卡片则新建一张）
//   - 指向【.html 文件】 -> 挂到 html 所在文件夹那张卡片的 links 列表（没有卡片则新建一张）
//   - 指向【.exe/其他】  -> 跳过（软件快捷方式不导入）
//   - 目标解析失败/路径不存在（盘符没插等） -> 跳过并单独列出
//
// 幂等保证（重复运行不会产生重复数据）：
//   - 已有同路径的卡片一律跳过，不覆盖你手工维护的备注/排序/bat/links
//   - 卡片下已有同名 file 的 bat / links 也跳过
//   - 写入前自动备份 data\projects.json -> projects.json.bak
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================
// 配置加载（与 server.js 同一套规则）
//   读取优先级：环境变量 > config.json > config.example.json > 内置默认值
//   本脚本只用到 desktopLnkImport 段；完整默认结构见 server.js 与 config.example.json。
// ============================================================
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

/** 内置默认配置（本脚本用到的部分：空来源、空分组规则） */
const DEFAULT_CONFIG = {
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
const DATA_FILE = path.join(ROOT, 'data', 'projects.json');

// 快捷方式来源目录（个人来源请写进 config.json 的 desktopLnkImport.sourceDirs，不要写死在代码里）
const LNK_SOURCE_DIRS = CFG.desktopLnkImport.sourceDirs || [];

// ---------- 自动分组规则 ----------
// 网页顶栏的分组标签就靠卡片上的 group 字段。
// 规则：把卡片路径转成小写后，按"路径前缀"从上往下匹配，第一条命中的组名生效。
// 命中的卡片写入 group；没命中的 group 留空，网页里显示在「全部」标签下。
// 规则来自 config.json 的 desktopLnkImport.groupRules，格式 [[路径前缀(小写), 组名], ...]。
// 注意：路径统一是小写、反斜杠分隔，因为脚本会先把你的路径同样标准化再比较。
const GROUP_RULES = CFG.desktopLnkImport.groupRules || [];

// ---------- 工具 ----------

/** 清洗快捷方式文件名 -> 卡片显示名：去 .lnk 后缀、「 - 快捷方式」、「 (2)」等尾缀 */
function cleanName(lnkFileName) {
  let name = lnkFileName.replace(/\.lnk$/i, '');
  // 反复去掉尾缀，处理「xxx - 快捷方式 (2)」这种叠 buff 的情况
  for (;;) {
    const before = name;
    name = name.replace(/\s*[-－—–]\s*快捷方式\s*$/i, ''); // 去「- 快捷方式」
    name = name.replace(/\s*\(\d+\)\s*$/, '');              // 去「(2)」「(3)」
    if (name === before) break;                              // 没变化了就结束
  }
  return name.trim() || lnkFileName;
}

/** 路径标准化为小写（Windows 路径不区分大小写，用于去重比较） */
function normKey(p) {
  return String(p).replace(/\\/g, '\\').replace(/[\\]+$/, '').toLowerCase();
}

/** 判断路径是否存在且是文件夹 */
function isRealDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

/** 判断路径是否存在且是文件 */
function isRealFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/** 按上面 GROUP_RULES 查该路径属于哪个分组；没命中返回空字符串 */
function matchGroup(p) {
  const key = normKey(p);
  const hit = GROUP_RULES.find(([prefix]) => key.startsWith(prefix));
  return hit ? hit[1] : '';
}

/**
 * 批量解析 .lnk 目标路径。
 * .lnk 是 Windows 二进制格式，Node 读不了，交给系统 PowerShell 一次性全部解析
 * （逐个调用会启动 60+ 次 powershell，太慢）。结果写入临时 JSON 文件再读回，
 * 避免中文经控制台转码变乱码。
 */
function resolveLnks(sourceDir) {
  // 1. 生成临时 PowerShell 脚本：遍历 .lnk，用 WScript.Shell 解析 TargetPath
  const psScript = [
    'param([string]$Source, [string]$Out)',
    '$ErrorActionPreference = "SilentlyContinue"',
    '$shell = New-Object -ComObject WScript.Shell',
    '$result = @()',
    'Get-ChildItem -LiteralPath $Source -Filter *.lnk -File | ForEach-Object {',
    '  $t = ""',
    '  try { $t = $shell.CreateShortcut($_.FullName).TargetPath } catch {}',
    '  $result += [pscustomobject]@{ file = $_.Name; target = $t }',
    '}',
    'if ($result.Count -eq 0) { $json = "[]" } else { $json = $result | ConvertTo-Json -Compress }',
    '[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))',
  ].join('\r\n');

  const psFile = path.join(os.tmpdir(), 'kilo-lnk-resolve.ps1');
  const outFile = path.join(os.tmpdir(), 'kilo-lnk-result.json');
  fs.writeFileSync(psFile, psScript, 'utf8');

  // 2. 执行（execFileSync 同步等待，简单可靠）
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', psFile,
    '-Source', sourceDir,
    '-Out', outFile,
  ], { timeout: 60000, windowsHide: true });

  // 3. 读回结果（UTF-8，无乱码问题）
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (!Array.isArray(items)) items = [items]; // 只有一条时 PowerShell 会给单个对象
  } catch (_) { /* 解析失败按空处理 */ }
  try { fs.unlinkSync(outFile); } catch (_) {}   // 清理临时文件
  try { fs.unlinkSync(psFile); } catch (_) {}
  return items;
}

// ---------- 主流程 ----------
try {
  // ============ 第 0 步：没配置来源目录就直接退出（不是错误，别让用户以为脚本坏了） ============
  if (LNK_SOURCE_DIRS.length === 0) {
    console.log('[提示] 未配置快捷方式来源目录。');
    console.log('       请在 config.json 的 desktopLnkImport.sourceDirs 里填写要扫描的目录后重试。');
    process.exit(0);
  }

  // ============ 第 1 步：扫描所有来源目录，解析每个 .lnk 的真实目标 ============
  const lnks = []; // { file, dir, target }
  for (const src of LNK_SOURCE_DIRS) {
    if (!isRealDir(src)) {
      console.log(`[跳过] 来源目录不存在: ${src}`);
      continue;
    }
    const items = resolveLnks(src);
    console.log(`[读取] ${src} 共 ${items.length} 个 .lnk 快捷方式`);
    for (const it of items) {
      lnks.push({ file: it.file, dir: src, target: String(it.target || '').trim() });
    }
  }

  // ============ 第 2 步：读取现有卡片数据，准备分类合并 ============
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const data = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    : { cards: [] };
  data.cards = Array.isArray(data.cards) ? data.cards : [];

  // 各分类的统计与明细
  const stats = { newCard: 0, addBat: 0, addLink: 0, groupFill: 0, skipExist: 0, skipExe: 0, skipMissing: 0 };
  const missingTargets = []; // 目标不存在的明细（盘符没挂载等）
  let seq = 0;

  // ============ 第 2.5 步：给还没分组的卡片（含老卡片）预先填分组 ============
  // 只填 group 为空的卡片；已经分过组的尊重现状不覆盖 -> 重复运行也不会有任何变化。
  for (const card of data.cards) {
    if (card.group) continue;
    const g = matchGroup(card.path);
    if (g) {
      card.group = g;
      stats.groupFill++;
      console.log(`[分组] ${card.name} -> ${g}`);
    }
  }

  /** 按"路径小写"找已有卡片 */
  function findCardByPath(p) {
    const key = normKey(p);
    return data.cards.find(c => normKey(c.path) === key);
  }

  /** 新建一张卡片的公共函数 */
  function newCard(name, p) {
    const card = {
      id: 'c' + Date.now() + '-' + seq,
      name,
      path: p,
      note: '',
      order: data.cards.length + 1,
      bats: [],
      links: [],
      group: matchGroup(p) || '',
    };
    data.cards.push(card);
    seq++;
    return card;
  }

  /** 往卡片挂 bat（file 只填文件名，后端 runBat 会校验它在卡片目录内）；同名已存在则跳过 */
  function attachBat(card, file, label) {
    card.bats = Array.isArray(card.bats) ? card.bats : [];
    if (card.bats.some(b => String(b.file).toLowerCase() === file.toLowerCase())) {
      stats.skipExist++;
      console.log(`[已有] bat 已挂过: ${card.name} -> ${file}`);
      return;
    }
    card.bats.push({ file, label: label || '', order: card.bats.length + 1 });
    stats.addBat++;
    console.log(`[挂bat] ${card.name} -> ${file}`);
  }

  /** 往卡片挂 html 链接（file 为相对卡片目录的相对路径）；同名已存在则跳过 */
  function attachLink(card, file, label) {
    card.links = Array.isArray(card.links) ? card.links : [];
    const norm = file.replace(/\//g, '\\');
    if (card.links.some(l => String(l.file).replace(/\//g, '\\').toLowerCase() === norm.toLowerCase())) {
      stats.skipExist++;
      console.log(`[已有] 链接已挂过: ${card.name} -> ${norm}`);
      return;
    }
    card.links.push({ file: norm, label: label || '', order: card.links.length + 1 });
    stats.addLink++;
    console.log(`[挂链接] ${card.name} -> ${norm}`);
  }

  // ============ 第 3 步：逐个分类处理 ============
  for (const lnk of lnks) {
    const displayName = cleanName(lnk.file);
    const target = lnk.target;

    // 3.0 目标为空或不存在 -> 跳过（盘符未挂载、目标被删等）
    if (!target || (!fs.existsSync(target))) {
      stats.skipMissing++;
      missingTargets.push(`${lnk.file} -> ${target || '(解析失败)'}`);
      continue;
    }

    // 3.1 指向文件夹 -> 新建卡片（同路径卡片已存在则跳过）
    if (isRealDir(target)) {
      if (findCardByPath(target)) {
        stats.skipExist++;
        console.log(`[已有] 卡片已存在: ${target}`);
        continue;
      }
      newCard(displayName, target);
      stats.newCard++;
      console.log(`[新卡片] ${displayName} -> ${target}`);
      continue;
    }

    // 剩下的都是指向文件；先取出文件所在文件夹和扩展名
    const ext = path.extname(target).toLowerCase();
    const parentDir = path.dirname(target);

    // 3.2 指向 .bat -> 挂到 bat 所在文件夹的卡片
    if (ext === '.bat') {
      if (!isRealDir(parentDir)) { // 理论上文件存在则目录必存在，双保险
        stats.skipMissing++;
        missingTargets.push(`${lnk.file} -> ${target}`);
        continue;
      }
      let card = findCardByPath(parentDir);
      if (!card) {
        // 该文件夹还没有卡片 -> 新建一张，卡片名取文件夹名
        card = newCard(path.basename(parentDir) || displayName, parentDir);
        stats.newCard++;
        console.log(`[新卡片] ${card.name} -> ${parentDir}（因 bat/html 而建）`);
      }
      attachBat(card, path.basename(target), displayName);
      continue;
    }

    // 3.3 指向 .html -> 挂到 html 所在文件夹的卡片
    if (ext === '.html' || ext === '.htm') {
      if (!isRealDir(parentDir)) {
        stats.skipMissing++;
        missingTargets.push(`${lnk.file} -> ${target}`);
        continue;
      }
      let card = findCardByPath(parentDir);
      if (!card) {
        card = newCard(path.basename(parentDir) || displayName, parentDir);
        stats.newCard++;
        console.log(`[新卡片] ${card.name} -> ${parentDir}（因 bat/html 而建）`);
      }
      // links 的 file 用"相对卡片目录"的路径（html 一般就在卡片目录里，即文件名本身）
      const rel = path.relative(parentDir, target) || path.basename(target);
      attachLink(card, rel, displayName);
      continue;
    }

    // 3.4 其余（.exe / 其他软件） -> 跳过
    stats.skipExe++;
    console.log(`[跳过] 非文件夹/bat/html: ${lnk.file} -> ${target}`);
  }

  // ============ 第 4 步：有变化才落盘（先备份），重新编号 order ============
  const changed = stats.newCard + stats.addBat + stats.addLink + stats.groupFill > 0;
  if (changed) {
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); // 备份，出问题可手动改回
    console.log('[备份] 已保存 data\\projects.json.bak');
    data.cards.forEach((c, i) => c.order = i + 1);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } else {
    console.log('[提示] 没有任何新增，projects.json 保持原样（未写盘）。');
  }

  // ============ 第 5 步：输出统计报告 ============
  console.log('----------------------------------------');
  console.log(`[完成] 新增卡片 ${stats.newCard} 张 | 挂 bat ${stats.addBat} 个 | 挂链接 ${stats.addLink} 个 | 补分组 ${stats.groupFill} 张`);
  console.log(`       跳过：已有/重复 ${stats.skipExist} 个，exe等软件 ${stats.skipExe} 个，目标不存在 ${stats.skipMissing} 个`);
  if (missingTargets.length) {
    console.log('       目标不存在的快捷方式（盘符未挂载或已删除）：');
    missingTargets.forEach(m => console.log('         - ' + m));
  }
  console.log(`       总卡片数: ${data.cards.length}`);
  if (changed) console.log('       如服务正在运行，刷新网页(F5)即可看到新卡片。');
} catch (err) {
  console.error('[失败] ' + err.message);
  process.exit(1);
}
