---
name: dsh-heart-transplant
description: 换心适配模式——把任意 agent CLI 桥进 dsh Web UI 的通用套路。当用户想给 dsh 换新引擎、接别的 CLI（如 CodeBuddy）、改 BuddyAgent、或调试权限桥/问答桥/resume 链时使用。关键词：换心、BuddyAgent、canUseTool、resume、AskUserQuestion 桥、审批桥。
---

# 换心适配模式（Heart Transplant）

把外部 agent CLI 变成 dsh 的引擎，同时保留 dsh 原生交互（模型选择器 / 问答弹窗 / 审批面板）。核心实现：`dsh-buddy/lib/agent.js`（BuddyAgent）；交互缝在 dsh 源码 `packages/interaction/{user-questions,user-approval,tool-ask-user}`。

## 必守的七条规则（每条背后一次真实事故）

| 规则 | 违反后果 |
|---|---|
| ① BuddyAgent 构造时**扫会话日志恢复 lastTurn**（max(turn)），不许硬编码 0 | 所有回合撞号 turn:1，Web UI 历史只剩第一轮 |
| ② query 必须带完整会话链：dsh 会话 id（UUID）作 sessionId，首轮 create、之后 resume（init 消息 session_id 优先） | 每条消息都是新会话，模型失忆 |
| ③ resume 前置校验转录文件存在 + 60s 看门狗（收到 CLI 首条消息即解除） | CLI 对缺失转录**静默挂死**，无任何报错 |
| ④ canUseTool 必须注册且每个分支都返回 allow/deny；allow AskUserQuestion 必须带 `updatedInput.answers`（按问题文本做键） | `No permission handler` 报错，或答题后永久挂死 |
| ⑤ client 模块注册 id === npm 包名 | `Failed to load plugins` |
| ⑥ 桥内任何异常 → `deny + message` 失败关闭，不许吞掉或挂起等待 | 单点异常炸掉整个回合 |
| ⑦ **dsh ≥0.2.0：设置页卡片靠"条目 id + Config 的volatile 字段"自动投影**。`installSection()` 已删除；Config 至少要有一个 `.volatile()` 字段（空对象会被 `volatileForm()` 整条跳过） | 插件在设置页**静默隐身**——没有任何报错，只是卡片不见了 |

### 规则 ⑦ 的排查路径（"沉默失败"必须读到叶子）

卡片不见了没有任何报错。消费链要一路读到底，每一层都可能静默丢弃：

```
ModelsSection.tsx（画哪些行）
  → store.ts: joinProviderDirectory + configured 判定（命名空间视图是否存在）
    → catalog.ts: .filter(group => group.models.length > 0)
      → settings/index.ts: describe() —— schema(entry) / fiber.state / volatileForm 任一不过就跳过
        → schema.ts: volatileForm() —— 空 object 返回 undefined（最隐蔽的一层）
```

取证：在 settings 包目录内直接 import 它的 `volatileForm` 跑新旧 Config 对照，别靠推断。

## 双桥接线（已验收）

- **提问桥**：SDK `AskUserQuestion` → `ctx.get('userQuestions').ask({questions, agent, signal})`（waterfall 到问答弹窗）→ 人类答案回填 `updatedInput.answers` allow。
- **审批桥**：其他工具 → `buddy.autoApprove=true` 静默放行 / `false` → `ctx.get('approval').request({agent, toolName, reason, signal})`，**仅 allowed-once 算通过**，落 asked+decided 审计对。
- agents 注册表会做活性校验——BuddyAgent 须经 `agents.enter()` 注册才能过。

## 已知边界（详见《换心手术全记录.md》第十三章）

卡死类风险已封死（失败关闭 + 看门狗只管 CLI 启动期）；剩余语义错位类：ExitPlanMode 拒绝后模型循环重提计划、子代理权限继承未实测、AskUserQuestion 多题映射未实测、后台定时任务与对话交叉可能致转录交错。

## 桌面端移植（10-13 已验证通过）

官方桌面端（`deepseek.com/harness/` 下载，EV 签名主体="Hangzhou DeepSeek Artificial Intelligence Co., Ltd."）
是**另一套平行环境**，不是 web 的升级：

| 维度 | 值 |
|---|---|
| profile | Electron **独占** `$DSH_HOME/profiles/desktop`，与 web **不共享** node_modules / 插件激活 / 锁文件 |
| 端口 | **19387**（web 是 3080） |
| 运行时 | 内嵌 Node 24.18.1 + Electron 44；**插件与 Host 同一个 Electron Node 进程** |
| 符号链接 | **不启用 `--preserve-symlinks`**；打包应用"选择 runtime profile 解析，**不创建包链接**" |
| 插件入口 | `resources/runtime/cli/bin/dsh.cmd`（`ELECTRON_RUN_AS_NODE=1` + Electron 跑 `dsh-desktop-host/lib/cli.js`） |
| 兜底 | Safe Mode：`--safe-mode` 或菜单「Restart as Safe Mode…」，一键禁用第三方插件 |

**装法（与 web 不同，必须用 tarball）**：

```bash
# ① 先启动一次桌面端初始化 profile，再从托盘【完全退出】（关窗口只是隐藏！）
# ② 打包——本地目录 add 会因 link: 不落地而失败（见 dsh-troubleshoot）
pnpm pack --pack-destination <dir>
# ③ 安装
"<desktop>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add <dir>\dsh-buddy-<ver>.tgz
# ④ 重开桌面端
```

`add` 会自动把包名追加进 `dsh.profile.bundles`，无需手工改。

**移植前的三次预检**（这次全部一次通过，值得复用）：

```bash
# 用一次性 Electron 进程跑，不碰 profile
ELECTRON_RUN_AS_NODE=1 "<desktop>/DeepSeek Harness.exe" <脚本.js>
```

1. `spawn('codebuddy', ['--version'], {shell:true})` → 应得退出码 0（**插件命脉**；PATH 与绝对路径都实测可达）
2. `createRequire(插件入口).resolve('@tencent-ai/agent-sdk')` 及 6 个 peer deps → 应全部 OK
3. `import('dsh-buddy')` → 应成功加载并导出 `BuddyLoop`

**已知坑**：
- `--dump-config` 被拒（CLI 不能 boot desktop profile），最终验证只能靠实际启动 + 看黑匣子
- peer deps 会经 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 后备目录解析，可能指向**本地源码仓库**而非 app.asar 内嵌版 → 确保**两边版本一致**（本次都是 0.2.0-rc.2，实测无碍）

## 深挖入口

- 事故全记录与排障：《换心手术全记录.md》十~十三章；**桌面端移植见第二十一章**
- SDK 类型：`dsh-buddy/node_modules/@tencent-ai/agent-sdk/lib/types.d.ts`
- 框架机制：`deepseek-harness/docs/user/develop/framework/`（生命周期/服务/事件）
- 桌面端权威说明：`deepseek-harness/apps/desktop/README.zh.md`
