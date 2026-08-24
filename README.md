# T101

T101 是一款面向英雄联盟国服的 数据分析助手

> 仅分析对局数据与本地界面展示，不执行任何游戏内自动化操作。

## 核心功能

- **BP 推荐**：根据对面已选英雄推荐克制 Pick；提供版本强势 Ban 与针对我方阵容的威胁 Ban。
- **对局分析**：版本英雄榜、英雄对位克制、加载画面 10 人信息（英雄 / 位置 / 段位）。
- **海克斯大乱斗**：共享英雄池推荐、海克斯牌推荐与最佳搭档。
- **窗口跟随**：自动识别 LOL 客户端 / 游戏窗口，面板贴靠其右侧，全屏或最大化时仅调整面板位置；不抢占焦点、不使用置顶、不改变 Z 序。

## 使用

### 环境要求（Windows）

- Windows 10 / 11
- Rust stable（MSVC 工具链）
- WebView2 Runtime

### 构建与启动

```powershell
npm run panel:build   # 首次编译约 2~5 分钟
npm run panel         # 启动面板
```

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `F9` | 一键排布游戏窗口与面板 |
| `F10` | 暂停 / 恢复窗口跟随 |
| `Ctrl+Alt+F12` | 退出面板 |

## 签名与校验

构建产物通过 **Sigstore 无密钥签名**（cosign，开源免费、无需私钥）保证供应链完整性：

- **CI 构建签名**：推 tag（`v*`）或手动触发 `build-sign` 工作流（Windows runner），产物为 `t101-panel.exe` 与 NSIS 安装包 `t101-panel_<版本>_x64-setup.exe`，均附带 `.sigstore.json` 签名 bundle，自动发布到 GitHub Release。
- **发布说明**：在 GitHub Release 页面编写，仓库内不维护发布记录文件。

校验 Release 产物：

```powershell
cosign verify-blob --bundle t101-panel.exe.sigstore.json `
  --certificate-identity "https://github.com/stophemo/T101/.github/workflows/build-sign.yml@refs/heads/master" `
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
  t101-panel.exe
```

注意：Sigstore 是开源供应链签名，**Windows SmartScreen 不识别它**，首次运行仍可能提示「未知发布者」（需要 CA 证书才能显示「已验证发布者」，后续可接入 Azure Trusted Signing 或购买代码签名证书）。

## 已知限制

- 仅支持 Windows；无自动更新。
- 游戏独占全屏时普通窗口无法稳定覆盖，建议使用无边框或窗口化模式。

## 免责声明

> **本项目仅供学习交流与技术研究使用。**
>
> - 本项目不保证运行稳定性、功能完整性或任何使用结果。
> - 本项目仅做数据查询与本地界面展示，不执行任何自动 Ban、Pick、锁定等游戏内操作。
> - 使用时请遵守相关法律法规、软件许可协议及游戏用户协议，不得用于作弊、破坏游戏公平性等违规用途。
> - 因使用、修改或传播本项目产生的一切风险与后果，由使用者自行承担。
> - 如本项目涉及需移除或修改的内容，请联系项目维护者。
>
> **使用本项目即表示你已阅读并同意以上免责声明。**

## 许可证

MIT License，详见 [LICENSE](LICENSE)。
