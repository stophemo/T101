# lol-assistant（命令：`lola`）

英雄联盟国服 BP 助手。终端 CLI + 本地 Web 双端，覆盖两个核心场景：

1. **BP 阶段**：根据对面已选英雄，推荐克制/胜率最高的 Pick；给出 Ban 建议（手动输入或 LCU 自动读取）
2. **加载界面**：自动查出当前对局 10 名玩家的英雄/位置/段位/等级（来自本地客户端，无需查网站）

## 命名

| 项 | 命名 | 说明 |
|---|---|---|
| 仓库/目录 | `lol-assistant` | 项目名 |
| CLI 命令 | `lola` | `lol-assistant` 缩写，避免和系统命令 `lol` 冲突 |
| 入口 | `src/cli.ts`（commander） | `lola pick 亚索,盲僧` 这类子命令风格 |

## 核心场景与命令

```
lola pick <对面英雄列表>            # 例：lola pick 亚索,盲僧,锤石
                                   # → 按位置推荐克制对面胜率最高的英雄（可 -l MIDDLE 按位置）
lola ban [我方已选英雄]             # → 无参数=版本强势榜；有参数=克制我方的（该 ban 的）
lola rank -l MIDDLE                # → 当前版本英雄榜单（胜率/登场率/禁用率/T级）
lola hero 劫                       # → 单英雄对位克制（谁克它/它克谁）
lola hex                           # → 海克斯大乱斗：英雄胜率榜 + 海克斯牌推荐
lola champselect [-w]              # → 选人阶段实时 BP 推荐（LCU 自动读取双方英雄，-w 持续监听）
lola loading                       # → 加载画面 10 人信息（召唤师/英雄/位置/段位/等级）
lola lcu status                    # → 检测客户端连接与当前阶段
lola web                           # → 启动本地 Web 界面（浏览器打开）
lola cache clear                   # → 清缓存
```

## 架构

```
lol-assistant/
├── bin/lola.mjs                   # 全局命令包装（tsx 运行 CLI）
├── src/
│   ├── cli.ts                     # commander 入口，子命令分发
│   ├── models.ts                  # 数据模型（各数据源统一返回这里的类型）
│   ├── api/
│   │   ├── cn101.ts               # 101.qq.com 官方数据（主数据源：榜单/对位/海克斯/英雄表）
│   │   └── lcu.ts                 # 本地客户端 API（选人/加载画面，只读）
│   ├── services/
│   │   ├── pick.ts                # Pick 推荐（纯函数可单测）
│   │   ├── ban.ts                 # Ban 建议（纯函数可单测）
│   │   ├── champselect.ts         # 选人阶段分析（LCU session → BP 推荐）
│   │   └── hextech.ts             # 海克斯大乱斗推荐（英雄 + 海克斯牌）
│   ├── utils/
│   │   ├── cache.ts               # JSON 文件缓存（内存常驻 + 防抖落盘）
│   │   └── table.ts               # 终端表格（中文双宽度对齐）
│   └── web/
│       ├── server.ts              # 零依赖 Web 服务（node:http，仅绑 127.0.0.1）
│       └── index.html             # 前端（原生 JS，7 个面板）
├── data/cache.json                # 本地缓存（自动生成）
└── tests/                         # node:test 单测（解析器 + 服务纯函数）
```

上层 services 只依赖 `models.ts` 的数据模型，不关心数据来源；CLI 与 Web 复用同一套 services。

## 数据源方案（已实测验证）

### ✅ 主数据源：101.qq.com 官方接口（国服）

国服玩家数据在 `101.qq.com`（英雄联盟官方数据站），前端调用的 API 已逆向验证，**完全可用、免 Key、无鉴权**：

| 接口 | 用途 | 实测状态 |
|---|---|---|
| `GET https://mlol.qt.qq.com/go/database/versionlist?zone=lol&from=h5` | 版本列表 | ✅ 返回全部版本（含最新 16.16） |
| `GET .../lol_101strategy?itier=255&version_id=16.16&lane=ALL&sort_metric=1&sort_order=2` | 全英雄榜单：胜率/登场率/禁用率/T级/克制列表 | ✅ 每行 `排名_英雄id_T级_位置_胜率_登场率_禁用率_克制英雄ids_排名变化` |
| `GET .../lol_101strategy_confront?itier=255&championid=63&lane=SUPPORT&version_id=16.16` | 单英雄对位克制（high_op/low_op） | ✅ 返回克制它/被它克制的英雄+胜率 |
| `GET https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js` | 英雄中文名/英文名/id 映射 | ✅ 静态文件，量大可本地缓存 |
| `GET .../lol_101strategy_confront?itier=255&championid=55&lane=MIDDLE&version_id=16.16` | 单英雄对位（英雄详情页同源）：high_op=它的劣势对线（选这些克制它）、low_op=它的优势对线 | ✅ 带精确对位胜率，lane 必须为具体位置 |
| `GET .../lol_101strategy_partner?championid=55&lane=MIDDLE` | 最佳拍档：与该英雄同队的组合胜率 | ✅ `rank_heroId_组合胜率_场数_胜场` |
| `GET .../lol_101strategy_segment?championid=55&lane=MIDDLE` | 单英雄各段位强度：`itier_胜率_登场率_禁用率` | ✅ 与榜单全段位数据互相印证 |
| `GET .../fuwen_aram_hero_rank_v2?dtstatdate=YYYYMMDD` | 海克斯大乱斗英雄榜 | ✅ 按日更新、延迟一天（自动回退） |
| `GET .../fuwen_aram_rune_rank_v2?dtstatdate=YYYYMMDD` | 海克斯牌榜 | ✅ 同上 |

参数说明：`itier`=段位（255 全段位 / 10 王者 / 9 宗师 / 8 大师 / 7 钻石 / 6 翡翠 / 5 铂金 / 4 黄金 / 3 白银 / 2 青铜 / 1 黑铁）；`lane`=TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT/ALL；`version_id` 传版本**名字**（如 `16.16`）。

还有 build（出装）/rune（符文）/skill（加点）/partner（搭档）/trend（趋势）等接口，后续可扩展。

### ✅ LCU API（本地客户端）——加载画面/选人实时数据

客户端启动后在 `127.0.0.1` 开放 HTTPS 端口（凭据在 lockfile 或进程命令行中），本工具**只读 GET**（与 Porofessor/Blitz/U.GG 等主流工具一致，不做任何自动操作）：

- 选人阶段：双方英雄/ban/位置/队列 id → `lola champselect` 或 Web「BP 助手」面板
- 加载画面：10 人召唤师名/英雄/位置/段位/等级 → `lola loading` 或 Web「加载画面」面板
- 连接探测：lockfile（Riot/腾讯常见路径）+ 进程命令行兜底，结果短缓存 5s

### 🔶 参考数据源：OP.GG（外服 meta，未接入）

OP.GG **不覆盖国服**，仅作参考（韩服强势英雄）。其 `api/v1.0/internal/bypass/...` 接口已失效（改 Next.js RSC 渲染），需要解析页面 HTML，列为 Phase 3 的尽力而为功能，挂了不影响主流程。

## 技术选型

- **TypeScript + Node 24**，`tsx` 直接运行，`commander` 做 CLI
- **内置 fetch**，无 HTTP 依赖；`data/cache.json` 本地缓存（榜单 6h / 英雄表 30 天，内存常驻 + 防抖落盘）
- **npm link** 全局安装后可直接敲 `lola` 命令；Windows 下自动 `chcp 65001` 避免中文乱码
- Web 服务零依赖（`node:http` + 原生前端），**仅绑定 127.0.0.1**（不暴露到局域网）

## BP 算法（v2：对位驱动）

### Pick 推荐
1. 对面英雄各自位置：LCU 场景用 assignedPosition；手动输入按榜单登场率推断主位置
2. 对每个对面英雄查**对位接口**（与官网 hero-detail 页同源）：high_op = 它的劣势对线（选这些英雄打卡特琳娜有 57~71% 胜率）
3. 候选 = 所有对位克星的并集，按（克制数 → 平均对位胜率 → 段位榜单胜率）综合排序
4. 展示：英雄/位置/段位强度 T 级/段位胜率/**逐对位胜率**（如 `卡特琳娜 58.9%`）

> ⚠️ v1 曾用榜单 `counters` 字段（每行克制列表），实测质量差（如卡特琳娜的 counters 含加里奥——实际被卡特克），已弃用。

### Ban 建议
- **无我方阵容**：版本梯度榜——按段位拉全位置榜单，T0→T2 梯度优先，组内按禁用率+胜率排序（优先 ban 版本强势）
- **有我方阵容**：对位威胁分析——查每个我方英雄的 low_op（被谁克制），候选按（威胁数 → 对位胜率 → 版本禁用率加权）排序，展示 `亚索 41.8%`（我方英雄 vs 威胁英雄的对位胜率，<50% 即被克）

### 段位自动适配
- LCU 场景自动读取当前账号段位（单双排优先）→ 映射为 itier（王者 10 … 黑铁 1）
- 榜单/对位/分段数据全部按该段位查询（如钻石分段卡特琳娜的对位克星与全段位差异明显）
- 查不到段位（未排位/客户端差异）时自动回退全段位 255；手动命令可用 `-t` 指定

### 最佳拍档
`lola hero` 与 Web 面板可查拍档数据（组合胜率），后续可在选人时推荐队友组合。

## 使用（Phase 1 + Phase 2 已完成 ✅）

```
npm install && npm link     # 首次安装（之后直接敲 lola）

lola pick 亚索,盲僧,锤石          # 对面已选 -> 推荐克制英雄（可 -l MIDDLE 按位置、-t 7 按段位）
lola ban                         # 版本强势/高禁用榜（无参数）
lola ban 亚索,永恩                # 给出我方阵容 -> 推荐克制我方的（该 ban 的）
lola rank -l MIDDLE              # 当前版本英雄榜单
lola hero 劫 -l MIDDLE           # 单英雄对位克制（谁克它/它克谁）
lola hex                         # 海克斯大乱斗：英雄胜率榜 + 海克斯牌推荐
lola champselect -w              # 选人阶段实时 BP 推荐（自动读双方英雄，-w 持续监听）
lola loading                     # 加载画面 10 人信息
lola lcu status                  # 检测客户端连接
lola cache clear                 # 清缓存
```

所有命令支持：`-t/--tier` 段位（255 全段位/10 王者/9 宗师/8 大师/7 钻石/6 翡翠/5 铂金/4 黄金/3 白银/2 青铜/1 黑铁）、`--no-color`。英雄名支持中文（劫/安妮）、称号（影流之主）、英文（Zed）、ID。

## Web 界面（`lola web` ✅）

```
lola web            # 启动后自动打开浏览器 http://127.0.0.1:8765
lola web -p 9000    # 自定义端口
```

零依赖（node:http + 原生前端），仅本机可访问，包含 7 个面板：

| 面板 | 功能 |
|---|---|
| 🎯 BP 助手 | **仅两个模式自动激活**：峡谷排位（单双排/灵活）→ Pick/Ban 推荐；海克斯大乱斗 → 英雄胜率+海克斯牌推荐；其他模式提示不在支持范围 |
| 🃏 海克斯大乱斗 | 英雄胜率榜（附推荐海克斯牌/最佳搭档）+ 海克斯牌榜（胜率/出场率/适合英雄/品质） |
| ⚔ Pick 推荐 | 手动输入对面英雄 → 克制推荐卡片（头像/T级/胜率/克制对象） |
| 🛡 Ban 建议 | 版本强势榜 或 按我方阵容推荐 |
| 📊 榜单 | 位置+段位筛选的英雄榜单 |
| 🔍 对位克制 | 单英雄的克制/被克制关系 |
| 🎮 加载画面 | **对局加载时自动列出 10 人信息**（召唤师/英雄/位置/段位/等级），自动刷新 |

顶部状态栏实时显示客户端连接状态与当前阶段（大厅/选人/加载/对局中）。

### 开发与重启规则

| 改动内容 | 是否需要重启 |
|---|---|
| 前端页面（`src/web/index.html`） | ❌ 不用，刷新浏览器即可（服务器每次请求读取） |
| 后端逻辑（`src/web/server.ts` / 服务代码） | ✅ 需要重启 `lola web` |
| CLI 命令（`lola pick` 等） | ❌ 不用，每次运行都是新进程 |

日常开发推荐用监听模式（代码变更自动重启服务）：

```
npm run web:watch      # tsx watch：改代码后自动重启
```

其它 npm scripts：`npm run web`（等价 `lola web`）、`npm test`（单元测试）、`npm run lola -- <args>`。

## 模式支持与数据源说明

**仅支持两个模式**：峡谷（单双排/灵活排位）与海克斯大乱斗。

| 模式 | BP 推荐 | 数据源 |
|---|---|---|
| 单双排（420） | ✅ Pick/Ban 推荐 | 101 峡谷榜单 |
| 灵活排位（440） | ✅ Pick/Ban 推荐 | 101 峡谷榜单 |
| 海克斯大乱斗 | ✅ 英雄胜率 + 海克斯牌推荐 | `fuwen_aram_hero_rank_v2` / `fuwen_aram_rune_rank_v2` |
| 普通大乱斗/匹配/其他 | ❌ 提示不在支持范围 | — |

> ⚠️ 注意：
> 1. 101 官方峡谷榜单**不区分单双排/灵活**（实测 queue 参数无效，官方统一口径），两种排位使用同一套峡谷数据
> 2. 海克斯大乱斗数据按日更新且**延迟一天**（当天查的是前一天数据，工具自动回退）
> 3. 海克斯大乱斗在 LCU 的 queueId **待实战确认**：450=普通大乱斗明确排除，未知 id 按海克斯处理（CLI/Web 会显示实际 queueId 便于反馈）

## Roadmap

- [x] **Phase 1**：101 官方接口客户端 + `lola pick` / `lola ban` / `lola rank` / `lola hero` / `lola hex`（国服数据）
- [x] **Phase 2**：LCU 集成（`src/api/lcu.ts`）——选人实时读取（`lola champselect` + Web BP 面板），加载画面自动汇总 10 人信息（`lola loading`）
- [ ] **Phase 3**：OP.GG 韩服数据解析，pick/ban 结果双数据源并排展示
- [ ] **Phase 4**：掌上英雄联盟 App 接口逆向（查历史战绩）；Windows 桌面悬浮窗

## 待确认问题

1. ~~玩的区服？~~ → 已确认：**国服**，官方数据源 101.qq.com ✅
2. ~~选人时手动输入对面英雄，还是走 LCU 全自动？~~ → 两者都做了：手动 `lola pick` / 自动 `lola champselect` ✅
3. 海克斯大乱斗的 LCU queueId（当前未知 id 按海克斯处理，需实战确认）
4. 是否需要 Windows 桌面悬浮窗（显示在游戏上方），还是终端/浏览器输出就够？
