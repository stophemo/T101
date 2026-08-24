# T101 0.0.1

首个公开版本，面向英雄联盟国服玩家提供 CLI、Web 对局面板和 Windows Tauri 侧边面板。

## 本版内容

### 对局分析

- 新增 `pick`：根据对手英雄、位置、对位胜率和段位强度推荐 Pick。
- 新增 `ban`：支持版本梯度 Ban 和针对我方阵容的对位威胁 Ban。
- 新增 `rank`、`hero`、`hex`：查询版本榜、英雄对位、最佳拍档和海克斯大乱斗统计。
- 新增 `champselect`：从本机 League Client LCU 读取房间、Ban、Pick、操作顺序和倒计时。
- 新增 `loading`：读取加载画面 10 人信息和近期战绩。
- 新增 `lcu status`：检查 League Client 连接与当前游戏阶段。

### 海克斯大乱斗

- 共享英雄池改为读取 LCU `session.benchChampions`。
- 队友或对手的 `championId` 只用于展示当前已选英雄，不再作为共享池来源。
- 共享池英雄按胜率和登场率计算推荐分，并附带推荐海克斯牌和最佳拍档。
- LCU 尚未返回共享池时明确提示，不使用错误的队友已选英雄回退。

### Web 与 Windows 面板

- 新增原生 JS 窄窗 Web UI，围绕 400px 面板优化房间、Ban、Pick、海克斯、加载和游戏中视图。
- 默认 Web 服务端口调整为 `7892`。
- 新增 Tauri 2 Windows 侧边面板构建和启动流程。
- 面板固定宽度约 400px，贴靠 League 客户端或游戏窗口右侧。
- 面板关闭系统级 `always-on-top`，保持普通窗口层级。
- 停靠使用不改变 Z 序、不激活目标窗口的 Windows 窗口定位方式。
- F9 排布、F10 停靠开关、Ctrl+Alt+F12 退出。

### 工程整理

- 增加本地缓存和版本/日期快照机制，减少重复抓取公开统计接口。
- 支持 101.qq.com 国服数据和 OP.GG 韩服参考数据。
- 移除无入口的旧监控、图标生成和调试脚本。
- 移除未使用依赖和 Tauri capability 权限。
- 保留 28 项自动化测试，并通过 TypeScript 类型检查。

## 安装与运行

环境要求：Node.js 22+。在仓库目录执行：

```powershell
npm install
npm run web
```

默认打开或访问 <http://127.0.0.1:7892>。CLI 示例：

```powershell
npm run t101 -- pick 亚索,盲僧
npm run t101 -- champselect -w
npm run t101 -- loading
```

Windows Tauri 面板需要 Rust、WebView2 和对应 Windows 工具链。构建：

```powershell
npm run panel:build
npm run t101 -- web --panel
```

## 已知限制

- LCU 依赖 League Client 正在运行，客户端接口字段可能随版本变化。
- 海克斯共享池依赖当前 session 返回 `benchChampions`；没有池数据时不会猜测。
- Tauri 面板首发只面向 Windows，暂不提供安装包和自动更新器。
- 游戏独占全屏时普通窗口无法稳定覆盖游戏，建议使用无边框或窗口化模式。
- 统计结果是对局参考，不构成胜率保证。

## 校验

本版发布前通过：

- `npm test`
- `npx tsc --noEmit`
- 内嵌前端 JavaScript 语法检查
- Tauri Windows GNU release 构建
