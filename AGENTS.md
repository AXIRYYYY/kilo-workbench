# Kilo Workbench — 项目规则与经验（AGENTS.md）

> 本文件是本项目的开发规则与踩坑手册，供在本仓库工作的开发者与 AI 助手阅读。
> 安装、配置与使用说明见 `README.md`；变更历史见 `CHANGELOG.md`。

---

## 1. 项目是什么

单机网页卡片工作台：Node 后端 + 单文件前端页面，展示快捷入口卡片（打开文件夹 / VS Code / bat 脚本 / 网页直链 / 备注 / 分组 / 双视图切换），并内置一个只读的 Kilo 多项目监控台。

组件一览：

| 文件 | 作用 |
|------|------|
| `server.js` | 端口 7788（可配置），静态页 + 数据读写 + 打开类接口 + 监控台模块；每请求重读 `data\projects.json`，改卡片数据免重启，改 server.js/index.html 需重启/强刷 |
| `public\index.html` | 前端全部（内联 JS），卡片渲染、右键菜单、两种视图、装箱算法、监控台视图 |
| `data\projects.json` | 用户卡片数据：`{cards:[{id,name,path,note,order,group,bats:[],links:[]}]}`（已 git 忽略） |
| `data\projects.example.json` | 示例卡片，`projects.json` 不存在时展示 |
| `config.json` / `config.example.json` | 用户配置 / 配置模板 |
| `启动工作台.bat` / `关闭工作台.bat` | 启停服务（bat 源码为 GBK/ANSI + CRLF，禁 BOM） |

---

## 2. 装箱算法（核心规则）

### 2.1 网格视图「全部」标签 = 分段 DP 预计算装箱

- **不做实时启发**。数据一变（卡数序列 `counts.join(',')` 作指纹）就为**列数 1..6 每一档**离线各算一份最佳摆法，**结果存 localStorage `wb-pack-v1`**（含指纹），刷新/重开直接查表；实际列数 >6 时现算并补写本地（正常屏幕到不了）。
- 「最佳」定义（按既定裁决优先级）：
  1. **无空洞**：非末页每一行的卡片行必须占满；
  2. **总行数最少**（DP 对组序列切段，每段要么「相邻小组合计正好 = nG」，要么「单组独占行」）；
  3. 行数并列取段更长的（挤压优先）。
- 每行只有两种形态：**搭配挤**（几个小组各占 1 卡行、合计=列宽）/ **整行平铺**（单组独占：n>nG 时 ceil(n/nG) 行、内部列数=nG；n≤nG 时卡横向摊开占满整行）。
- 组内列数由布局结果下发 `sp.k`，末卡用 `applyTailSpan` 消掉组内空位。
- 结论性事实：**此方案不会出现「2×2 与 2×2 左右拼接」**——多行组永远独占整行，无法与多行块/缺口咬合。若将来想要拼缝咬合，方向是精确搜索（maxrects/skyline 类 2D strip packing；本场景组多约 7 组、列数≤6，可离线精确 DFS/B&B，参考点：Jylänki "A thousand ways to pack the bin"、libgdx MaxRectsPacker、secnot/rectpack）。经评估后决定：维持现状即可。

### 2.2 其他布局规则（已锁定）

- 卡片统一窄宽 `MASONRY_CARD_W=240`，间距 `GAP=12`，组框外壳开销 `FRAME_EXTRA=26`。
- **横条视图**（默认）：`#grid.stacked` 纯竖排，组间距 8px，卡行 padding 3px、note 30px、组标题下距 4px；**单组标签也走组框结构**（▣ 组名 + 卡片竖排）——不搞平铺分支。
- **网格视图单组标签** = 瀑布流窄卡平铺（`#grid` 自己就是卡片容器，`layoutGroupGrid` 按容器宽算列数）。
- **视图决定 DOM 结构**：`applyView` 切换后必须 `render()` 重建结构再排版（render 末尾自带 rAF→relayoutMasonry）。
- 布局分支统一入口 `relayoutMasonry`：`#grid.stacked` 两种视图分支；单组瀑布流分支；横条单组已并入组框路径。

---

## 3. 关键坑（都踩过，别再踩）

### 3.1 Windows / 编码

- `.bat`：**GBK(ANSI) + CRLF**，禁 BOM；含中文 `.ps1`：**UTF-8 带 BOM**；`.ps1` 写文件用 `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding($false)))`（无 BOM 才不破坏 YAML frontmatter）。
- PowerShell 5.1 控制台按 GBK 处理字符串：**含中文/嵌套引号的 node 代码一律写成临时 .js 文件再 `node file.js`**，不要 `node -e` 内联（嵌套引号必死）。
- PowerShell 的 `2>nul` 会被解析到宿主进程（`com1` 设备报错）——redirect 写在 `cmd /c "..."` 引号**内部**。

### 3.2 服务端 / 打开类接口（server.js）

- 打开文件夹的朴素方案（已定版）：`spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref()`。曾试验 helper（powershell + FindWindow + ShowWindow）强制激活前台，副作用大（开了又关、抢占手开窗口），**不要再加激活补丁**；窗口偶尔不抢焦点属 Windows 机制，接受。
- 拉起外部进程后**服务必须重启**才生效（杀端口 → `启动工作台.bat` 隐藏启动 → HTTP 200 验证）。验证别被旧进程误导。
- 判断窗口可见性用 `IsWindowVisible(hwnd)`；中文路径必须走 node REST（UTF-8），PowerShell `Invoke-WebRequest` 会 GBK 乱码误判 400。

### 3.3 页面 JS 与调试

- 改动 `index.html` 内联 JS 后：先抽取 `<script>` 内容写临时文件 → `node --check`，改页面必 Ctrl+F5。
- headless 验证用 **chrome.exe**（`--headless=new --dump-dom`、`--virtual-time-budget`）；msedge.exe 该参数经常导出 0 字节。dump 的 DOM 含页面源码，检查正则要锚足上下文。
- Playwright：`channel:'msedge'`（自带 chromium 可能损）；顶层 `const` 在 `page.evaluate` 里可直接访问；并行 context 隔离 localStorage。
- `debug` 后门：URL `?view=grid|list` 强制视图；localStorage `wb-view` 记忆视图，`wb-pack-v1` 存装箱指纹+方案。

### 3.4 数据与一致性

- 卡片顺序：`cards.sort(order)` → 按顶栏 `getAttribute(group)` 顺序渲染，「其他」恒排最后。
- 批量数据改动后逐项校验；JSON 改坏时先备份 → diff → 逐字段核对，勿手乱补。

---

## 4. 开发约定

- **先备份再改**：改动文件前一律存 `*.bak-<日期>`。
- **最小改动**：一次只做一件事，改前先说明目的，不要顺手重构无关代码。
- **几何 / 排布类改动的最省心路径**：备份 → 抽取内联 JS → `node --check` → Playwright 无头实测（1920/1440/1000 三档宽度 + 横条/单组回归）→ 用无头浏览器结果验收。
- 设置类改动（主题、视图记忆、标签顺序）全部 localStorage 持久化，刷新后必须保持。
- 内联 HTML 常出现单一来源卡片高度互换；一旦结论已定就立即停手，尊重既有决策。

---

## 5. 快速验证清单（改完必对）

1. `node --check` 服务端与抽取的内联 JS。
2. 杀端口 → `启动工作台.bat` → HTTP 200 + `<title>工作台</title>`。
3. Playwright：网格视图三档宽度，几何与 DP 期望逐块一致、无空洞；横条视图纯竖排；单组标签结构正确。
4. `projects.json` 改动后 `JSON.parse` 校验；改中文字段后用 `content.includes('目标中文')` 断言，别依赖控制台输出（控制台是 GBK，必然乱码）。

---

## 6. 监控台（Kilo 多项目监控台，内置模块）

### 6.1 是什么

监控台是工作台服务的**内置模块**：Node 单进程、单入口、网页内双视图互切（工作台 ↔ 监控台）。

| 项 | 事实 |
|---|---|
| 数据源 | `~/.local/share/kilo/kilo.db`（WAL）**只读**打开；`KILO_MON_DB` 环境变量或 `config.json` 的 `monitor.dbPath` 可覆盖 |
| 实现 | `server.js` 里的「监控台模块」，用 Node 内置 `node:sqlite`（零第三方依赖） |
| 接口 | `GET /api/monitor/events`（SSE 主通道：连接即推、变化才推、30s 心跳）；`GET /api/monitor/sessions?ver=N`（兜底轮询，ver 相同回 `{"changed":false}`） |
| 低开销 | 空闲每秒 1 次 `PRAGMA data_version`（只读内存映射 WAL 头，约 0.05ms/次）；只有 Kilo 真写库才重算快照 |
| 前端 | `public\index.html` 里的第二段 `<script>`（IIFE 隔离，不污染工作台全局名）；CSS 全部限定在 `#monView` 下、类名 `mon` 前缀 |
| 视图切换 | `localStorage['wb-appview']`（work/mon）；URL `?view=monitor` 调试后门；顶栏「📡 监控台 (N)」按钮显示未读数 |
| 提醒 | 与当前视图无关，页面加载即常驻：响铃（Web Audio）+ 系统通知（标题=项目名）+ 标签页标题 `(N) 工作台` |
| 关闭 | 网页「⏹ 关闭服务」→ 单进程退出；`关闭工作台.bat` 另清可能残留的旧版 4719 端口进程 |

### 6.2 前端语义（改之前先读懂，改完必须回归）

- 状态三态：`active`（90 秒内有更新）/ `review`（最后一条是 assistant 且静默满 90 秒）/ `idle`；用 `Date.now()` 现算，**不许**冻结在快照时间。
- 未读基线 `localStorage['kiloMonitorSeenV1']`：**首次打开时跳过"正处于活跃期"的会话**（它们马上要转 review，正是最该提醒的一批），只把已安静的老会话标为已读。
- 未读判定：`!(id in seen) || timeUpdated > seen[id]`。
- 提醒只在「非 review → review」边沿触发一次，且仅限结束后 30 分钟内；更早的只静默挂角标。
- 边界闹钟：收到数据后算出下一次 90 秒跨界时刻，排一次性 `setTimeout`；空闲零轮询。
- 「测试提醒」按钮：与状态判定解耦，直接响铃 + 弹「监控台测试」（排障用）。
- 容错：错误快照（数据源坏掉）没有 `projects` 字段 —— `render` / `scheduleBoundaryRender` / `latestOf` 都做了守卫，否则抛 TypeError。

### 6.3 验证清单（改监控台相关代码后必跑）

1. `node --check server.js`；页面内联脚本共 **2 段**，两段都要抽取后 `node --check`。
2. `GET /api/monitor/sessions` → 返回各项目快照；`?ver=<当前ver>` → `{"changed":false}`；`/api/monitor/events` 立即收到一帧。
3. 布局回归：横条 + 网格视图在 1920/1440/1000 三档无空洞、无重叠、无横向溢出；切到监控台再切回，工作台几何与切走前逐块一致。
4. 提醒链路：把 `KILO_MON_DB` 指向一个仿真小库（含"几秒前 assistant 回复"的会话）→ 停在**工作台视图** → 把页面时钟前移 120 秒 → 等约 90 秒 → 应弹通知 + 响铃 + 标题 `(N) 工作台`。
5. 容错：`KILO_MON_DB` 指向不存在的库 → 工作台卡片/右键菜单全部正常，监控视图显示错误提示，控制台零异常。

### 6.4 顶栏与视图切换（UI 约定）

**唯一一条常驻顶栏**（`<header>`），两个视图共用，从左到右三块：

| 位置 | 元素 | 规则 |
|---|---|---|
| 最左（固定） | `#appSwitch` 分段切换器：`🗂️ 工作台` \| `📡 监控台` | **位置在两个视图下必须逐像素一致**；未读数字写进定宽槽 `#monCount`（0 → (12) 都不改变按钮宽度，切换器不抖动）；`.active` 类标记当前视图 |
| 中段（伸缩） | `#ctxInfo`（`flex:1`） | 内容随视图换：工作台在线状态 `#status` / 监控摘要 `#monSummary` + 连接态 `#monConn`（用 CSS 切换显隐）；只有左缘位置固定，宽度允许随右侧按钮数量变化 |
| 最右（锚定） | 动作按钮组 | `.wbOnly`（➕添加卡片/🌙主题/☰横条）只在工作台显示；`.monOnly`（测试提醒/开启通知）只在监控台显示；`⏹ 关闭服务` **不带视图类且排最右**（右对齐天然锚定，不随按钮增减移动） |

**铁律 / 禁止事项**

- 禁止给 `body.mon-active` 加 `padding`、`margin`、`position` 之类会移动顶栏的规则 —— 切视图时顶栏必须纹丝不动（曾犯：`body.mon-active{padding:0}` 让整个顶栏左移 24px）。
- 监控台页内**不再有自己的标题栏和返回按钮**（原 `.monHead` 已删除），也不要有第二套「测试提醒/开启通知」按钮。
- 未读数只能写进 `#monCount`、权限提示只能切 `#monPermHint.show`；`window.wbSetMonBadge(n, needsPerm)` 是唯一入口，不要把整段文字写进按钮（会抹掉内部 span 并改变宽度）。

**主题：监控视图跟随工作台**（不再自带浅色主题）

- `#monView` 只做变量映射：`--fg:var(--text)`、`--muted:var(--text-dim2)`、`--line:var(--border)`、`--active:var(--accent)`；`--card` / `--bg` 直接用工作台的，**不要在 `#monView` 里重新定义**（那是自我覆盖，会失效）。
- 🌙/☀️ 一切换，两个视图一起变。

**回归断言（改顶栏后必跑）**：`#appSwitch`、`#monBtn`、`⏹ 关闭服务` 三个元素的矩形（left/top/width/height）在两个视图下必须相同；`#ctxInfo` 只比左缘（1px 容差）。

---

## 7. 配置化约定

- 所有与本机环境相关的参数一律走配置，**禁止在代码里写死本机路径**：
  - 读取优先级：**环境变量 > `config.json` > `config.example.json` > 内置默认值**。
  - 默认路径用 `os.homedir()` 推算（如 `~/.local/share/kilo/kilo.db`），不要写死用户名或盘符。
  - 新增/调整配置项时，同步更新 `config.example.json` 与 `README.md` / `README.zh-CN.md` 的配置章节。
- `config.json` 与 `data/projects.json` 是用户本地文件，**永远不要提交**，也不要在示例、文档或代码注释里引用它们的内容。
- 卡片数据的读取顺序：`data/projects.json` 存在则用它，否则回退 `data/projects.example.json`；保存时**永远只写** `data/projects.json`。
