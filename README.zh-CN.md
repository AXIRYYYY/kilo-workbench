# Kilo Workbench · 本地工作台

[English](README.md) | 简体中文

一个跑在你自己电脑上的本地单机网页工作台：把常用项目做成**卡片墙**（打开文件夹 / VS Code / 运行 `.bat` / 打开本地 `.html` / 备注 / 分组），并内置一个**只读**的 Kilo 会话监控台，一屏看清所有项目的会话状态。

- **零第三方依赖** —— 纯 Node.js 内置模块实现
- **卡片墙** —— 一键打开文件夹、拉起 VS Code、运行 `.bat`、打开本地 `.html`，支持备注与分组
- **两种视图** —— 横条列表（默认）与网格，离线 DP 预计算装箱布局，不出现空洞
- **内置 Kilo 监控台** —— SSE 实时推送各项目会话状态（活跃 / 待查看 / 空闲），带未读角标与系统通知
- **只读设计** —— 监控台以 `readOnly` + `PRAGMA query_only` 打开 Kilo 数据库，服务只监听 `127.0.0.1`

---

## 环境要求

- **Node.js v22.5 或更高版本**（监控台使用内置 `node:sqlite` 模块，建议 v24）
- Windows 系统（启动脚本，以及"打开文件夹 / 运行 bat / VS Code"这些操作都是面向 Windows 的）

Node 版本偏低时卡片墙仍可正常使用，只有监控视图会提示 `node:sqlite` 不可用。

## 快速开始

```bat
:: 可选：创建你自己的配置（不创建则使用内置默认值）
copy config.example.json config.json

:: 启动隐藏后台服务
启动工作台.bat
```

或者用命令行：

```bash
node server.js
```

然后打开 <http://localhost:7788>。

## 配置说明

配置读取优先级（从高到低）：

1. **环境变量** —— `KILO_MON_DB`、`KILO_OPENCODE_DB`
2. **`config.json`** —— 你的本地配置（不会提交到仓库）
3. **`config.example.json`** —— 随仓库发布的模板
4. **内置默认值**

把 `config.example.json` 复制为 `config.json` 后按需修改：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `port` | `7788` | 服务端口。改动后需同步修改 `启动工作台.bat` 里的 URL。 |
| `host` | `127.0.0.1` | 监听地址。请保持回环地址：本服务可以打开文件夹、运行 `.bat`。 |
| `vscodeCommand` | `code` | "VS Code" 按钮调用的命令。 |
| `monitor.dbPath` | `""` | `kilo.db` 路径。留空 = `~/.local/share/kilo/kilo.db`。 |
| `monitor.probeIntervalMs` | `1000` | 只读 `PRAGMA data_version` 探测间隔。 |
| `monitor.snapshotDays` | `7` | 只展示最近 N 天有活动的会话。 |
| `monitor.recentWindowSec` | `1800` | 只对最近 N 秒内活跃的会话查询最后一条消息的角色。 |
| `monitor.maxSessionsPerProject` | `20` | 每个项目最多返回的会话条数。 |
| `monitor.heartbeatSec` | `30` | SSE 心跳间隔。 |
| `monitor.errorCooldownSec` | `30` | 快照构建失败后的重试冷却时间。 |
| `monitor.pageCacheKb` | `-32000` | SQLite 页缓存上限（负数 = KiB）。 |
| `opencodeImport.dbPath` | `""` | `opencode.db` 路径。留空 = `~/.local/share/opencode/opencode.db`。 |
| `opencodeImport.pathBlacklist` | `[]` | 从 opencode 导入时要跳过的路径。 |
| `desktopLnkImport.sourceDirs` | `[]` | 存放 `.lnk` 快捷方式的来源目录。 |
| `desktopLnkImport.groupRules` | `[]` | 自动分组规则，格式 `[[路径前缀, 组名], ...]`。 |

`config.json` 里的数组会**整体覆盖**模板里的数组（不是拼接）。

## 数据与隐私

- 卡片数据只保存在本机 `data/projects.json`，且已被 git 忽略。
- 监控台以**只读**方式打开 Kilo 数据库并设置 `PRAGMA query_only = 1`，物理上无法写入或损坏数据。
- 服务只监听 `127.0.0.1`，局域网内其他设备访问不到。

## 示例数据

首次运行时如果 `data/projects.json` 不存在，页面会展示 `data/projects.example.json` 里的示例卡片（路径是 `C:\Users\Public` 这类通用目录）。只要你在网页上添加或编辑过卡片，程序就会写出你自己的 `data/projects.json`；此后**永远优先读你自己的文件**。

## 项目结构

```text
.
├─ server.js                    # HTTP 服务：卡片读写、打开/运行类接口、内置监控台
├─ public/index.html            # 前端全部（内联 JS）：卡片墙、右键菜单、视图切换、监控台
├─ data/projects.json           # 你的卡片数据（已忽略，首次保存时生成）
├─ data/projects.example.json   # 示例卡片，projects.json 不存在时展示
├─ config.json                  # 你的配置（已忽略）
├─ config.example.json          # 配置模板
├─ import-opencode.js           # 可选：从 opencode 数据库导入项目目录
├─ import-desktop-links.js      # 可选：从桌面快捷方式导入文件夹 / bat / html
├─ 启动工作台.bat                # 启动服务（隐藏窗口）
├─ 关闭工作台.bat                # 关闭服务
├─ 导入opencode项目.bat          # 运行 import-opencode.js
├─ 导入桌面快捷方式.bat           # 运行 import-desktop-links.js
├─ AGENTS.md                    # 给 AI 编程助手看的项目规则
└─ CHANGELOG.md
```

## 可选导入脚本

两个导入脚本都只**追加**数据，永远不会覆盖你已有的卡片。

- `导入opencode项目.bat` —— 从 `opencode.db` 读取去重后的项目目录，生成卡片。
- `导入桌面快捷方式.bat` —— 从 `desktopLnkImport.sourceDirs` 读取 `.lnk`，指向文件夹的生成卡片，指向 `.bat` / `.html` 的挂到对应文件夹的卡片上。**请先在 `config.json` 里填好来源目录与分组规则。**

## 常见问题

- **提示端口被占用** —— 服务多半已经在运行，直接打开 <http://localhost:7788> 即可。
- **提示 `node:sqlite` 不可用** —— 升级到 Node v22.5+（建议 v24）。在此之前监控视图会显示错误，卡片墙不受影响。
- **打开的文件夹窗口落在浏览器后面** —— 这是 Windows 的焦点机制。属于有意为之：强行抢焦点的补丁会带来更糟的副作用。
- **部分终端里 bat 中文乱码** —— 脚本是 UTF-8 + `chcp 65001`，新版 Windows Terminal 能正常显示。

## 开发

```bash
node --check server.js
node server.js
```

发布（维护者用）：

```bash
git remote add origin https://github.com/AXIRYYYY/kilo-workbench.git
git push -u origin main
```

## 许可证

[MIT](LICENSE)
