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
| `dsh-buddy/` | ⭐ **可直接分发的插件包**：`install.mjs` 自动安装器 + 使用指南，别人换心走这里 |
| `buddy-loop/` | 手术原型插件（BuddyLoop 工厂 + BuddyAgent 驱动器，含 resume/持久化/inbox 完整实现） |
| `buddy.patch.yml` | 换心装配：禁用原生 `agent-loop`，insert 挂载 `buddy-loop` |
| `dsh-recon/` | Stage-1 验证脚本与依赖修复记录（历史参考） |
| `test-query.mjs` | Spike：直连 CodeBuddy CLI 的最小验证 |
| [`换心手术全记录.md`](./换心手术全记录.md) | 📖 **完整复盘**：架构、时间线、12 个踩坑全记录、patch 语义速查、Agent 契约面 |

## 快速开始（三步换心）

前置条件：已安装并登录 codebuddy CLI、已安装 dsh（npm 包或源码构建均可）、Node ≥ 20。

```bash
# 1. 克隆本仓库
git clone https://github.com/AzcHui/dsh-buddy-spike.git
cd dsh-buddy-spike

# 2. 运行安装器（自动探测 dsh 宿主、建链接、生成 patch、自检）
node dsh-buddy/install.mjs
# 探测不到宿主时手动指定：
# node dsh-buddy/install.mjs --host <dsh 的 bin.js 路径>

# 3. 用安装器打印的点火命令启动
node <bin.js> web --patch <生成的 buddy.patch.yml> --port 3210
```

打开 `http://127.0.0.1:3210`，新建会话发消息，回答来自 CodeBuddy 即成功。

## 核心原理

- **官方换件入口**：dsh 的 `cordis.patch.yml` 支持按 id 覆盖插件行 —— 禁用 `agent-loop` 行 + `insert` 新行挂自定义工厂（服务名同为 `agentLoop`，消费者无感知）
- **patch 不能换名**：overlay 行的 `name` 与目标行不同会被静默跳过，只能"禁用旧行 + insert 新行"
- **相对锚定**：insert 行的 `name` 用 `./lib/index.js` 相对 patch 文件定位，绕开裸包名解析锚点在 profile 目录的坑
- **peerDependencies 策略**：插件的全部 `@deepseek-ai/*` 依赖声明为 peer，由安装器逐包 junction 到宿主真实路径，杜绝 cordis 双实例
- **单例自检**：cordis / schemastery（`Symbol.for` 全局注册表，先加载者称王）在安装时双向比对解析路径

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
