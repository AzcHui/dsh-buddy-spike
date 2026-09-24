---
name: dsh-plugin-dev
description: 开发 dsh (deepseek-harness) 插件的最短路径。当用户要写新插件、封装 tool、打包 bundle、发布分发、或插件加载失败排错时使用。关键词：dsh 插件、bundle、cordis.patch.yml、Schemastery、plugin add、热更。
---

# dsh 插件开发指南（踩坑浓缩版）

**第一步永远是读文档**，本地 = 线上，以文档为准：

- `deepseek-harness/docs/user/develop/basic/` — 第一插件 / tool / 插件配置 / 打包安装（publish）
- `deepseek-harness/docs/user/develop/framework/` — 生命周期 / 服务与依赖 / 事件
- `deepseek-harness/docs/user/develop/practice/` — 三层拆分 / LLM 适配器 / 运行时 Cordis 工具
- CLI 行为权威：`apps/cli/reference/README.zh.md`（层优先级 / flag / profile 机制）

## 硬性规则（违反即失败）

1. **Config 必须导出 Schemastery schema**，不能是普通对象——否则插件加载失败。
2. **插件/client 模块 id === npm 包名**。dsh 按包名严格校验注册，id 不符 → Web UI 报 `Failed to load plugins ... loaded without registering "xxx"`。
3. **patch 替换整行 config，不深度合并**。覆盖上层配置必须重述该行全部键。
4. **层叠顺序**：bundles 按加入序（先 @deepseek-ai/dsh-base）→ profile 自身 cordis.patch.yml → `$DSH_HOME/cordis.patch.yml` → `--patch` argv 序；**后应用层按行胜出**。

## 安装与分发

```
dsh plugin --profile <name> add ./pkg-dir        # 本地目录
dsh plugin --profile <name> add github:user/repo # GitHub（拉源码不构建！）
dsh plugin --profile <name> add ./x.tgz          # pnpm pack 产物
dsh --profile <name>                             # 启动（dsh web 是其硬编码别名）
```

- bundle 声明：package.json 里 `"dsh.bundle": { "patch": "./cordis.patch.yml" }`；patch 行内引用用**裸包名**（包已装入 profile node_modules）。
- GitHub git 安装：作者需自包含 `prepare` 构建脚本，用户需在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds`。**免授权分发 = 发 npm 或 `pnpm pack` tarball**。
- 配置热更：改 cordis.yml 中插件 config 即触发插件热替换（卸载旧实例→重载，注册自动清理），不用重启。

## pnpm v11 两个坑（本仓实录）

1. `hoisted=true` + `link:` 时顶层 node_modules 链接不落地 → 手动建 junction 补。
2. `link:` 不安装目标包的依赖 → 把依赖 junction 进自己包的 node_modules 自持。

## 验收流程

装好后 `dsh web --dump-config` 检查层栈是否正确（bundle 列表 + patch 行），再 Web UI 回归。**bundle 列表是启动时快照，装完插件必须重启 dsh。**
