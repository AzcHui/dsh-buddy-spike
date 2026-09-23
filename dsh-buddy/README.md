# dsh-buddy — 给 dsh 换上 CodeBuddy 大脑 🫀

让 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI / 终端用 **腾讯 CodeBuddy CLI** 作为唯一大脑：dsh 的 UI、会话、插件生态原样保留，回答来自 CodeBuddy，**用量走你的腾讯套餐积分，DeepSeek 零消耗**。

> 原理与完整踩坑记录见同仓库《换心手术全记录.md》。本插件是那台手术的"可复制版"。

## 它是什么

dsh 的一切皆插件，默认的 `agent-loop`（DeepSeek 驱动器）只是"出厂件"。本插件：

1. 用 patch 禁用原生 agent-loop，插入 `dsh-buddy` 行（提供同名 `agentLoop` 服务，dsh 其余部分无感知）
2. 每轮对话驱动一次 [`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk) 的 `query()`，SDK **自动复用 codebuddy CLI 的登录态**——积分直扣腾讯订阅
3. 流式事件全映射：思考链（reasoning-delta）、正文流（text-delta）、用量统计，dsh UI 原样展示

## 前置条件

| 依赖 | 要求 |
|---|---|
| dsh | npm 安装或源码构建均可（0.1.5-rc.3 实测通过，理论兼容 ≥0.1.4） |
| codebuddy CLI | **已安装且已登录**（腾讯积分从这里扣） |
| Node.js | ≥ 20 |
| 平台 | Windows（junction）/ macOS / Linux（symlink）均支持 |

## 三步换心

```bash
# 1. 拿到本包（git clone 或下载解压均可）
git clone <本仓库> dsh-buddy && cd dsh-buddy

# 2. 运行安装器（会自动探测宿主；探测不到就 --host 指定）
node install.mjs
#   source 版宿主: node install.mjs --host <仓库>/apps/cli/lib/bin.js
#   npm 版宿主:    node install.mjs --host <…>/node_modules/@deepseek-ai/dsh/lib/bin.js

# 3. 用安装器打印的点火命令启动（形如 ↓）
node "<dsh 的 bin.js>" web --patch "<dsh-buddy>/buddy.patch.yml" --port 3210
```

浏览器打开 `http://127.0.0.1:3210`，发消息——回答应来自 CodeBuddy（消息卡片显示用量，无 MISSING_CREDENTIAL 红字）。

安装器会自动完成并**自检**：

- 逐包解析宿主侧 6 个 peer 依赖（pnpm monorepo 未提升的包会 workspace 兜底扫描）
- 在插件目录建依赖链接（Windows junction / Unix symlink）→ 与宿主同源
- 校验 **cordis 单例**（宿主与插件必须解析到同一真实文件，双实例必炸）
- 校验宿主 patch 的三行目标行仍存在（`agent-loop` / `llm-pi-ai` / `session-title-llm`）
- 检查 codebuddy CLI 可用性

## 原理（为什么是这三步）

### patch 装配

```yaml
# 1. 禁用原生行（不带 name，干净生效）
- id: agent-loop
  disabled: true

# 2. 插入新行挂我们的驱动器（服务名同为 agentLoop，消费者无感）
- insert:
    - id: buddy-loop
      name: ./lib/index.js   # 关键：相对本 patch 文件锚定
```

两条从源码里挖出的铁律：

- **patch 不能换名**：patch 行的 `name` 与目标行不符会被**静默跳过**（只发一条 loader warning）——所以"禁用旧行 + insert 新行"是唯一正确姿势
- **`./` 相对路径是保命符**：loader 导入裸包名时锚点在 `DSH_HOME/profiles/web`，node_modules 上溯永远够不到你的插件目录；`anchorInsertedPluginNames` 会把 `./...` 换算成相对 patch 文件的绝对路径

### 依赖同源（单例保障）

插件的 `@deepseek-ai/*` 依赖全部声明为 **peerDependencies**，由安装器链接到宿主的真实路径（pnpm workspace 链接的落点）。原因有二：

- cordis / schemastery 都是**全局单例**（`Symbol.for` 注册表，先加载者称王）——插件与宿主版本不同源，全局 Schema/内核就会被旧版污染，典型炸点：`volatile is not a function`
- 双实例的 cordis 在 registry/代理追踪上会出现身份分裂

`@tencent-ai/agent-sdk` 是插件唯一私有依赖，独立无冲突。

## 已知限制

1. `steer` 是排队成下一轮，无真正中途打断
2. CodeBuddy 工具审批走它自己的流程，未映射 dsh 审批弹窗
3. resume 后旧历史不喂给 CodeBuddy 上下文（UI 历史完整，模型不记得）
4. 会话标题生成被禁用（原生实现要 DeepSeek key）
5. dsh 工具未通过 MCP 桥接给 CodeBuddy

## 常见问题

| 症状 | 处置 |
|---|---|
| boot 报 `timed out waiting for the writer lock ... .lock` | 陈旧锁文件（上次进程被杀残留），删掉该 `.lock` 再启 |
| 对话报 `no API key` | patch 没生效——查 boot 输出里的 loader warning（多半 patch 目标行 id 变了） |
| `Cannot find package 'dsh-buddy'` | patch 里 name 必须是 `./lib/index.js` 相对形式，不能用裸包名 |
| source 宿主编译后运行炸 `volatile`/`Cannot find entry` | 脏 checkout：切过版本后先 `pnpm clean && pnpm run build` 全量重编 |
| `--preserve-symlinks` 后一片红 | 别用。本插件入口是绝对路径直指，junction/symlink 由文件系统层透明解析 |

## 致谢与出处

- 手术原型与全部踩坑：`dsh-buddy-spike/`（本仓库上层目录），2026-09-22 ~ 09-23 两日完成
- 站在肩膀上：DeepSeek Harness（MIT，"驱动器保持可替换"）× 腾讯 CodeBuddy（`@tencent-ai/agent-sdk` 官方 SDK）
