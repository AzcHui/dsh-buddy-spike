# dsh-buddy-spike 🐿️

> **换心手术**：让 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 用上 **CodeBuddy CLI** 作为唯一大脑 —— 纯腾讯积分燃料，DeepSeek 零消耗。

## 这是什么

dsh 是"一切皆插件"的智能体框架，它的默认大脑是 DeepSeek。这个项目验证并落地了一个想法：**不改 dsh 一行源码，把 agent-loop 驱动器整个换掉**，让 dsh 的会话、UI、工具链全部照常工作，但每轮对话由 `@tencent-ai/agent-sdk` 驱动 CodeBuddy CLI 完成（复用其登录态，消耗腾讯 Coding Plan 积分）。

```
dsh Web UI ──会话/事件──▶ BuddyLoop（本仓库插件，服务名 agentLoop）
                              │
                              ▼
                   @tencent-ai/agent-sdk (query 流式)
                              │
                              ▼
                     codebuddy CLI（已登录）
                              │
                              ▼
                    腾讯 Coding Plan 积分
```

**实测效果**：dsh Web UI 新建会话发消息 → 思考链 + 流式回答 + 用量统计全部正常，来源标记 `codebuddy`，DeepSeek token 消耗为 0。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `dsh-buddy/` | ⭐ **标准 bundle 插件包**（`dsh.bundle` 声明 + `cordis.patch.yml` + 遥控器），一条 `dsh plugin add` 官方命令安装 |
| `buddy-loop/` | 手术原型插件（BuddyLoop 工厂 + BuddyAgent 驱动器，含 resume/持久化/inbox 完整实现，`--patch` 老路仍可用） |
| `buddy.patch.yml` | 旧版 `--patch` 装配（遗留；bundle 流程不需要它） |
| `dsh-recon/` | Stage-1 验证脚本与依赖修复记录（历史参考） |
| `test-query.mjs` | Spike：直连 CodeBuddy CLI 的最小验证 |
| [`换心手术全记录.md`](./换心手术全记录.md) | 📖 **完整复盘**：架构、时间线、12 个踩坑全记录、patch 语义速查、Agent 契约面 |

## 快速开始（官方 bundle 安装，一条命令换心）

前置条件：已安装并登录 codebuddy CLI、已安装 dsh（npm 包或源码构建均可）、pnpm 在 PATH 上、Node ≥ 20。

```bash
# 1. 克隆本仓库，进入插件包装依赖
git clone https://github.com/AzcHui/dsh-buddy-spike.git
cd dsh-buddy-spike/dsh-buddy
npm install --omit=dev        # 只装 @tencent-ai/agent-sdk；@deepseek-ai/* 是 peer，勿本地安装

# 2. 官方命令安装进 profile（内部转 pnpm，自动登记 bundle 层）
cd ..
dsh plugin --profile web add ./dsh-buddy    # profile 名按需换；pnpm 未落链接时见下方注意

# 3. 启动（不再需要 --patch）
dsh web                       # = dsh --profile web
```

打开 `http://127.0.0.1:3080`，新建会话发消息，回答来自 CodeBuddy 即成功。
不想启动只想验层：`dsh --profile web --dump-config`，应看到 `# == dsh-buddy` 层。

> **注意（Windows + pnpm ≥ 11 实测坑）**：`link:` 依赖的顶层链接偶发不落地
> （pnpm 报 Already up to date 但 `node_modules/dsh-buddy` 缺失）。手动补一个：
> `fs.symlinkSync(<checkout>, '<profile>/node_modules/dsh-buddy', 'junction')`，
> 再跑一次 `dsh plugin --profile web install` 触发登记即可。

## 遥控器（附赠）

换心后的 CodeBuddy 是个黑盒，但它的私有参数不必去改配置文件——插件自带一个设置面板（"买电视附赠的遥控器"）：

- **入口**：Web UI 设置页 → 「CodeBuddy 遥控器」分区
- **可调项**：`model` / 思考模式 `thinking`（自适应/固定预算/关闭）/ `maxTurns` / 工作目录 `cwd` / 环境变量 `env` / 系统提示词 `systemPrompt`（追加或覆盖）
- **生效时机**：保存后对新会话即时生效，无需重启 dsh；清空字段即回退 CLI 默认
- **落盘位置**：插件包目录的 `buddy-config.json`（已 gitignore——env 里可能放密钥）

原理：插件是 `dsh.client` 双面包——服务端 half 注册同源路由 `/api/buddy/config`（GET/POST + sameOrigin 校验），浏览器 half 经官方外部 UI 注入机制（`window.__ModuleLoader__` + `dsh.client.inject` 声明）由宿主自动分发加载，`ctx.slots` 挂进设置页。零源码改动、零构建链，client bundle 是手写的 `React.createElement`。

## 核心原理

- **官方换件入口**：dsh 的 `cordis.patch.yml` 支持按 id 覆盖插件行 —— 禁用 `agent-loop` 行 + `insert` 新行挂自定义工厂（服务名同为 `agentLoop`，消费者无感知）
- **patch 不能换名**：overlay 行的 `name` 与目标行不同会被静默跳过，只能"禁用旧行 + insert 新行"
- **标准 bundle 形态**：package.json 声明 `dsh.bundle.patch` → `dsh plugin add` 安装进 profile、自动加入 bundles 层栈，启动不再需要 `--patch`；patch 行用裸包名 `name: dsh-buddy`（bundle 已在 profile node_modules，Node 解析可达）
- **cordis 单例三重保障**：`@deepseek-ai/*` 全部声明 peerDependencies（profile 配 `autoInstallPeers: false` 不会本地安装）→ 解析链落到 dsh 维护的 `$DSH_HOME/profiles/node_modules` 后备目录 → 其链接直指宿主安装的真实包。schemastery 另有 `Symbol.for` 全局注册表兜底
- **外挂依赖自持**：bundle 的非宿主依赖（`@tencent-ai/agent-sdk`）装在插件包自己的 `node_modules` 里（ESM 沿链接路径解析时最先命中），不污染宿主、不依赖 registry 状态
- **层叠规则**（文档明载）：后应用的层按行胜出；patch 替换目标行整个 `config` 而非深度合并，覆盖时必须重述该行所有键

更多细节（含 12 个踩坑的"现象→根因→解决→教训"）见 [换心手术全记录.md](./换心手术全记录.md)。

## 已知限制

- CodeBuddy 侧每轮独立对话，resume 后旧历史不会喂给模型上下文（UI 历史完整）
- `steer` 只排队成下一轮，无真正的中途打断
- 工具审批走 CodeBuddy CLI 自己的审批流程，未映射到 dsh 的 approval 弹窗

## 致谢

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— "一切皆插件"的出色设计，让换心成为可能
- 腾讯 CodeBuddy / `@tencent-ai/agent-sdk`

## License

[MIT](./LICENSE)
