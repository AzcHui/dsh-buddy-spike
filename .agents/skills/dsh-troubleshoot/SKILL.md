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
| CLI resume 挂死 | 一直"思考中"无任何输出 | resume 不存在的转录**静默挂死不报错**；前置校验转录文件 + 60s 看门狗（已内建） |
| 装插件不生效 | 新插件没出现 | bundle 列表启动时快照，**装完必须重启 dsh** |
| PowerShell 工具输出空 | 连进程计数都拿不到 | 换 Bash 工具执行 |

## 修复后纪律

修完清掉取证日志；把根因和修复写进《换心手术全记录.md》对应章节，不写"神秘消失的自愈"。
