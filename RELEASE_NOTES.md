# T101 0.0.3

新增 NSIS 安装包并改为通过 GitHub Release 自动发布。

## 本版内容

- 新增 NSIS 安装包 `t101-panel_0.0.3_x64-setup.exe`，自动携带 `WebView2Loader.dll` 等运行文件，修复此前直接分发裸 exe 导致的「找不到 WebView2Loader.dll」无法启动问题；安装界面支持简体中文。
- 推 tag（`v*`）时 CI 自动构建、签名并发布 GitHub Release；安装包与裸 exe 均附带 Sigstore 签名（`.sig`）与证书（`.pem`）。
- 仍可通过 `npm run panel:verify` 校验裸 exe 的签名完整性；安装包同样附带签名文件可供校验。
- 说明：Sigstore 签名不改变 Windows SmartScreen 行为，首次运行仍可能提示未知发布者，选择「仍要运行」即可。

---

# T101 0.0.2

构建产物签名与仓库元信息更新。

## 本版内容

- 新增 Sigstore 无密钥签名（cosign）：GitHub Actions `build-sign` 工作流在 Windows runner 上构建并签名，产物附带 `.sig` 签名与 `.pem` 证书，可通过 `npm run panel:verify` 校验供应链完整性。
- 新增本地签名脚本 `scripts/sign-windows.ps1` 与 `npm run panel:sign`。
- 说明：Sigstore 签名不改变 Windows SmartScreen 行为，首次运行仍可能提示未知发布者。

---

# T101 0.0.1

首个公开版本，面向英雄联盟国服提供 Windows Tauri 侧边停靠面板。

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

Windows Tauri 面板需要 Rust、WebView2 和对应 Windows 工具链。构建：

```powershell
npm run panel:build
```

启动：

```powershell
npm run panel
```

## 已知限制

- 面板只面向 Windows，暂不提供安装包和自动更新器。
- 构建产物使用 Sigstore 无密钥签名（cosign）保证供应链完整性；不含 CA 证书签名，Windows SmartScreen 首次运行仍可能提示未知发布者。
- 游戏独占全屏时普通窗口无法稳定覆盖游戏，建议使用无边框或窗口化模式。
- 跟随依赖进程名识别 LOL 游戏/客户端主窗口；客户端未启动时面板回退到主屏右缘。

## 校验

本版发布前通过：

- `npm test`
- `npx tsc --noEmit`
- 内嵌前端 JavaScript 语法检查
- Tauri Windows GNU release 构建
