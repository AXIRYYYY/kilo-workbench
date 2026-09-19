# Changelog

本项目的所有重要变更都记录在此文件。

## [1.0.0] - 2026-09-19

### 首次发布

- **卡片墙工作台**：文件夹 / VS Code / `.bat` / 网页直链 / 备注 / 分组，横条与网格双视图切换
- **离线 DP 预计算装箱布局**：针对列数 1..6 各离线计算最优摆法并缓存到 localStorage，保证无空洞、总行数最少
- **内置 Kilo 多项目监控台**：以只读方式打开 `kilo.db`，SSE 实时推送，区分活跃 / 待查看 / 空闲三态，带未读角标与系统通知
- **零第三方依赖**：全部用 Node.js 内置模块实现（`http` / `fs` / `path` / `child_process` / `node:sqlite`）
- **配置外置**：`config.example.json` 模板 + `config.json` 用户覆盖，读取优先级为 环境变量 > `config.json` > `config.example.json` > 内置默认值
- **示例数据**：`data/projects.example.json` 演示卡片，用户首次保存后自动生成并优先读取 `data/projects.json`
- **可选导入脚本**：从 opencode 数据库、从桌面快捷方式导入项目卡片
