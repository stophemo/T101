# T101

`T101` 是面向《英雄联盟》国服的对局分析工具，命令行和本地 Web 面板共用同一套服务层。它读取 101.qq.com 的公开统计数据，以及本机 League Client 的只读 LCU 接口，为 BP、海克斯大乱斗和加载画面提供参考信息。

> 当前首发版本：`0.0.1`

## ⚠️ 免责声明（请务必阅读）

> **本项目仅供学习交流使用，不用于任何商业用途。**
>
> - 本项目仅为个人学习、技术研究而开发，不提供任何形式的数据准确性、可用性或胜率保证。
> - 项目读取的数据来自公开接口及本机 League Client 的只读接口，仅做展示与分析，不会执行任何自动操作（不自动 Ban / Pick / 锁定）。
> - 使用本项目时，请务必遵守《英雄联盟用户协议》《腾讯游戏许可及服务协议》以及拳头游戏的相关规定；因使用本项目产生的任何后果（包括但不限于账号风险），由使用者自行承担。
> - 如本项目涉及的任何内容侵犯了您的合法权益，请联系维护者删除相关部分。
>
> **继续使用本项目即表示您已阅读并同意以上条款。**

## 功能

- **Pick 推荐**：根据对手已选英雄、位置、对位胜率和段位强度推荐英雄。
- **Ban 推荐**：没有我方阵容时显示版本梯度；输入我方英雄后分析对位威胁。
- **英雄与版本榜**：查询英雄对位关系、最佳拍档、胜率、登场率、禁用率和 T 级。
- **海克斯大乱斗**：显示英雄榜、海克斯牌推荐，以及 LCU 当前返回的共享英雄池。共享池只使用 `session.benchChampions`，不会把队友已经选定的英雄误当成共享池。
- **LCU 选人分析**：自动读取房间、Ban、Pick、海克斯选人和当前操作倒计时。
- **加载画面信息**：列出 10 名玩家、英雄、位置、等级、段位和近期战绩。
- **Tauri 侧边面板**：Windows 下提供固定约 400px 的停靠面板，可贴在 League 客户端或游戏窗口右侧。

## 快速开始

环境要求：Node.js 22 或更高版本。LCU 相关功能还需要 League Client 正在运行。

```powershell
npm install
npm test
npm run web
```

## Web 面板

默认端口是 **7892**，服务只建议在可信网络中使用：

```powershell
npm run web
```

浏览器访问：<http://127.0.0.1:7892>

服务默认监听 `0.0.0.0`，因此同一局域网的设备可能看到控制台输出的访问地址。面板展示的是本机游戏数据；公共 Wi-Fi 或不可信网络环境下请不要开放访问。

## Windows 侧边面板

侧边面板使用 Tauri 2 构建，适合在选人和房间阶段与 League 客户端并排使用。它默认连接 `http://127.0.0.1:7892/`。

### 构建环境

- Rust stable
- Windows GNU 工具链，或 MSVC 工具链
- 使用 GNU 工具链时需要 `dlltool.exe`
- WebView2 Runtime

Windows GNU 构建示例：

```powershell
$env:Path = "C:\tools\winlibs\mingw64\bin;$env:Path"
npm run panel:build
```

构建产物：

```text
desktop/src-tauri/target/release/t101-panel.exe
```

启动服务和面板：

```powershell
npm run panel
```

也可以分开启动：

```powershell
npm run web
npm run panel
```

面板行为：

- 固定宽度 400px，默认不设置系统级置顶。
- 停靠时只更新位置和大小，不抢焦点、不改变窗口 Z 序。
- F9：把 League 客户端铺到工作区剩余区域，面板贴右；游戏全屏时只归位面板，不改变游戏窗口。
- F10：切换自动停靠。
- Ctrl+Alt+F12：退出面板。
- 游戏使用独占全屏时，Windows 不允许普通窗口稳定覆盖在游戏上方；建议使用无边框或窗口化模式。

## 数据源与隐私

- `101.qq.com`：国服英雄表、版本榜单、对位、拍档、海克斯大乱斗统计。
- OP.GG：韩服参考榜单，不代表国服实际环境。
- League Client LCU：本机选人、游戏流程、加载画面和近期战绩。工具只发送 GET 请求，不执行自动 Ban、Pick、锁定或其他游戏操作。
- 本地缓存位于 `data/cache.json`，统计快照位于 `data/snapshots/`。这些文件由运行过程生成，不应提交到仓库。
- Web 服务会读取本机的对局数据。默认端口为 7892，部署或转发到公网前请先确认访问控制和网络环境。

## 开发

```powershell
npm install
npm test
npx tsc --noEmit
npm run web:watch
```

前端文件是 `src/web/index.html`，使用原生 HTML、CSS 和 JavaScript。Tauri 构建使用 `desktop/dist/index.html`，修改前端后需要同步该文件：

```powershell
Copy-Item src/web/index.html desktop/dist/index.html -Force
```

`npm run panel:dev` 会同时启动 Web 服务 watch 和 Tauri dev 壳。后端或端口配置变更后需要重启服务和面板。

## 项目结构

```text
src/api/cn101.ts          101.qq.com 数据接口
src/api/opgg.ts           OP.GG 参考数据接口
src/api/lcu.ts            本地 League Client API
src/services/             Pick、Ban、海克斯、选人和战绩服务
src/web/server.ts         node:http 本地服务
src/web/index.html        Web 前端
desktop/src-tauri/        Tauri 2 Windows 面板
 tests/                   node:test 测试
```

## 已知限制

- 选人和加载画面信息依赖 League Client 的本地 API；客户端未启动、接口变化或尚未同步数据时，相关视图可能为空。
- 海克斯共享英雄池依赖当前 LCU session 返回的 `benchChampions`。如果客户端还没有返回池数据，界面会明确显示池数据尚未返回，不会用队友已选英雄回退填充。
- 普通大乱斗和未纳入支持范围的队列不提供峡谷 BP 推荐。未知队列会按海克斯大乱斗处理，并在 Web 中保留 queue id 便于反馈。
- 统计数据来自公开接口和本地快照，存在版本延迟、样本差异和国服/韩服环境差异，不应视为胜率保证。
- 当前 Tauri 面板首发面向 Windows，不提供安装包和自动更新器。

## 许可证

本项目使用 MIT License，见 [LICENSE](LICENSE)。
