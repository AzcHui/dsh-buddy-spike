---
name: dsh-troubleshoot
description: dsh 运行异常四步排障流程 + 环境陷阱清单。当 dsh 插件没运行、Web UI 空白、会话丢失、命令卡死、装了没生效等任何 dsh 相关故障时使用。关键词：排障、黑匣子、dsh-buddy.log、DSH_HOME、挂死、空白。
---

# dsh 排障指南（09-24 连环事故浓缩）

## 第零步（最容易跳过、最容易救命）

**先确认 dsh 实际用的 home**：`resolveDshHome()` 优先级 = 显式参数 > `$DSH_HOME` 环境变量 > `~/.dsh`。
排障第一步：`echo $env:DSH_HOME`（PowerShell）/ `echo $DSH_HOME`。历史事故：环境变量指向废弃测试 home，导致"插件全没运行"。

## 四步定位流程

1. **黑匣子**：`$DSH_HOME/logs/dsh-buddy.log`（JSONL，5MB 轮转 .old）。事件链：`agent-created → turn-start → query-start → cli-init → first-chunk → query-result`。有 turn-start 没 turn-end = 挂死或崩溃；看最后一个出现的事件即知断在哪层。
2. **会话日志**：`~/.dsh/sessions/<cwd桶>/session-<uuid>/session.v3.jsonl.zstd`。**多帧 zstd**：按魔数 `28 B5 2F FD` 正切帧逐帧解，zlib 单帧解法会失败。
3. **CLI 侧转录**：`~/.codebuddy/projects/<cwd-slug>/<sessionId>.jsonl`（换心场景）。
4. **还不明就里**：Web UI 按 F12 看 Network 红色失败请求。

## 环境陷阱清单（每条都是真实踩过的）

| 陷阱 | 表现 | 对策 |
|---|---|---|
| `$DSH_HOME` 劫持 | 插件全没运行 / 会话"消失" | 查环境变量，删掉或改对 |
| 端口记错 | 连不上 Web UI | `dsh web` 默认 **3080**，不是 3210 |
| PowerShell `*>` 落盘 | grep 乱码 | UTF-16 编码，先解码再搜 |
| MSYS 路径转换 | `DSH_HOME=/tmp` 被改写 | Git Bash 下用 Windows 风格路径 |
| CLI resume 挂死 | 一直"思考中"无任何输出 | resume 不存在的转录**静默挂死不报错**；前置校验转录文件 +60s 看门狗（已内建） |
| 装插件不生效 | 新插件没出现 | bundle 列表启动时快照，**装完必须重启 dsh** |
| PowerShell 工具输出空 | 连进程计数都拿不到 | 换 Bash 工具执行 |
| **对照环境污染** | 在 agent/IDE 里测出的结果 ≠ dsh 的结果，误判为"抖动" | 见下方专项，**最高频误判源** |

## 对照环境污染（10-08 血泪，建议单独记）

CodeBuddy CLI 的模型清单、可用能力等**按登录态/客户端身份动态下发**，受环境变量影响：

```
CODEBUDDY_CONFIG_DIR         指向 CLI 的登录凭据目录（如 ~/.workbuddy）
CLIENT_INFO_PRODUCT_VERSION  客户端版本标识
```

在 WorkBuddy 里跑和在用户终端跑，**同一命令会返回不同的清单**，且各自稳定（不是抖动）。

**取证纪律：**

1. **稳定的不一致 = 确定性的环境差异，不是随机抖动。** 遇到"同一命令两种结果"，先各跑 3 次确认稳定性，再谈抖动。
2. **对照必须与被测对象同环境。** 用 IDE/agent 的子进程去测"用户自己启动的服务"，测的不是同一个世界。
3. **定位手法**：把被测进程的环境缩到最小（`SystemRoot`/`PATH`/`APPDATA` 等），确认能复现；再用 **ddmin（delta debugging）** 在 187 个变量里缩到最小致因集——普通二分在非单调情况下会给假阳性。
4. **别急着改代码。** 先证明"差异是稳定的"，再判断是 bug 还是环境差异。否则会把环境问题修成代码补丁，越修越歪。

## 「升级依赖能不能解决问题」前置检查

问"升级 X 能不能拿到 Y"时，**先判定 Y 是本地静态还是服务端动态**——这决定升级有没有意义。

CodeBuddy 实例（10-08 实测）：模型清单**由服务端按账号通道下发**。

```
--help 的 "Currently supported:(...)"
  └─ 只是把远端结果打印出来，不是本地写死的清单
     真实来源：productManager.waitConfiguration() → $dataFolderName/cache/acc-product-config-v3.json
     通道由 CODEBUDDY_CONFIG_DIR 决定（~/.workbuddy = WorkBuddy 通道，copilot.tencent.com = 独立 codebuddy 通道）
```

所以：**升级 CLI 不会改变通道，也拿不到别的通道才有的模型/能力。**

查清单类问题的正确姿势（读压缩产物）：

```bash
grep -o "async updateModelOptionDescription.\{0,900\}" dist/codebuddy.js
```

**宿主差异陷阱**：CHANGELOG 里出现 `unopted 宿主（WorkBuddy）` 这类表述——同一份 CLI 会因宿主不同走不同分支。换心时遇到"莫名行为不一致"，先查是否有宿主分叉。

## 修复后纪律

修完清掉取证日志；把根因和修复写进《换心手术全记录.md》对应章节，不写"神秘消失的自愈"。
