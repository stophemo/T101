# T101

`T101` 是基于 Tauri 2 的《英雄联盟》侧边停靠面板：一个无边框的 400px 侧边窗口，自动跟随本机 League 客户端或游戏窗口，贴在窗口右侧边缘，不影响游戏操作。

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

- **窗口跟随**：自动识别 LOL 游戏主窗口（`League of Legends.exe`）或客户端主窗口（`LeagueClientUx.exe`），面板贴其右侧并保持普通窗口层级（不置顶、不抢焦点）。
- **全屏保护**：游戏铺满屏幕时，面板只归位到工作区右缘悬浮，**绝不移动或缩放游戏窗口**。
- **一键排布（F9）**：把游戏窗口铺到工作区剩余区域（约 2/3），面板固定 400px 贴在右侧。
- **跟随开关（F10）**：随时暂停/恢复自动跟随。
- **退出（Ctrl+Alt+F12）**：一键退出面板。

## 构建

环境要求：

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

## 使用

```powershell
npm run panel
```

或直接运行构建产物：

```powershell
desktop\src-tauri\target\release\t101-panel.exe
```

面板行为：

- 固定宽度 400px，默认不设置系统级置顶。
- 停靠时只更新位置和大小，不抢焦点、不改变窗口 Z 序。
- F9：把 League 客户端铺到工作区剩余区域，面板贴右；游戏全屏时只归位面板，不改变游戏窗口。
- F10：切换自动停靠。
- Ctrl+Alt+F12：退出面板。
- 游戏使用独占全屏时，Windows 不允许普通窗口稳定覆盖在游戏上方；建议使用无边框或窗口化模式。

## 开发

```powershell
npm run panel:build   # 构建 release 产物
npx tauri dev         # 在 desktop/ 目录下运行开发模式
```

面板前端是 `desktop/dist/index.html`（原生 HTML/CSS/JS），通过 Tauri invoke 与 Rust 后端交互（排布、跟随开关、状态查询）。修改后重新构建即可生效。

## 项目结构

```text
desktop/src-tauri/        Tauri 2 Windows 跟随面板（Rust 后端 + 停靠逻辑）
desktop/src-tauri/src/main.rs   窗口枚举、停靠、排布、热键
desktop/dist/index.html  面板前端（静态页）
```

## 已知限制

- 仅支持 Windows（依赖 Win32 API 枚举窗口与停靠）。
- 游戏使用独占全屏时无法稳定覆盖游戏窗口，建议无边框或窗口化模式。
- 跟随依赖进程名识别 LOL 游戏/客户端主窗口；客户端未启动时面板回退到主屏右缘。
- 不提供安装包和自动更新器。

## 许可证

本项目使用 MIT License，见 [LICENSE](LICENSE)。
