---
name: dsh-heart-transplant
description: 换心适配模式——把任意 agent CLI 桥进 dsh Web UI 的通用套路。当用户想给 dsh 换新引擎、接别的 CLI（如 CodeBuddy）、改 BuddyAgent、或调试权限桥/问答桥/resume 链时使用。关键词：换心、BuddyAgent、canUseTool、resume、AskUserQuestion 桥、审批桥。
---

# 换心适配模式（Heart Transplant）

把外部 agent CLI 变成 dsh 的引擎，同时保留 dsh 原生交互（模型选择器 / 问答弹窗 / 审批面板）。核心实现：`dsh-buddy/lib/agent.js`（BuddyAgent）；交互缝在 dsh 源码 `packages/interaction/{user-questions,user-approval,tool-ask-user}`。

## 必守的六条规则（每条背后一次真实事故）

| 规则 | 违反后果 |
|---|---|
| ① BuddyAgent 构造时**扫会话日志恢复 lastTurn**（max(turn)），不许硬编码 0 | 所有回合撞号 turn:1，Web UI 历史只剩第一轮 |
| ② query 必须带完整会话链：dsh 会话 id（UUID）作 sessionId，首轮 create、之后 resume（init 消息 session_id 优先） | 每条消息都是新会话，模型失忆 |
| ③ resume 前置校验转录文件存在 + 60s 看门狗（收到 CLI 首条消息即解除） | CLI 对缺失转录**静默挂死**，无任何报错 |
| ④ canUseTool 必须注册且每个分支都返回 allow/deny；allow AskUserQuestion 必须带 `updatedInput.answers`（按问题文本做键） | `No permission handler` 报错，或答题后永久挂死 |
| ⑤ client 模块注册 id === npm 包名 | `Failed to load plugins` |
| ⑥ 桥内任何异常 → `deny + message` 失败关闭，不许吞掉或挂起等待 | 单点异常炸掉整个回合 |

## 双桥接线（已验收）

- **提问桥**：SDK `AskUserQuestion` → `ctx.get('userQuestions').ask({questions, agent, signal})`（waterfall 到问答弹窗）→ 人类答案回填 `updatedInput.answers` allow。
- **审批桥**：其他工具 → `buddy.autoApprove=true` 静默放行 / `false` → `ctx.get('approval').request({agent, toolName, reason, signal})`，**仅 allowed-once 算通过**，落 asked+decided 审计对。
- agents 注册表会做活性校验——BuddyAgent 须经 `agents.enter()` 注册才能过。

## 已知边界（详见《换心手术全记录.md》第十三章）

卡死类风险已封死（失败关闭 + 看门狗只管 CLI 启动期）；剩余语义错位类：ExitPlanMode 拒绝后模型循环重提计划、子代理权限继承未实测、AskUserQuestion 多题映射未实测、后台定时任务与对话交叉可能致转录交错。

## 深挖入口

- 事故全记录与排障：《换心手术全记录.md》十~十三章
- SDK 类型：`dsh-buddy/node_modules/@tencent-ai/agent-sdk/lib/types.d.ts`
- 框架机制：`deepseek-harness/docs/user/develop/framework/`（生命周期/服务/事件）
