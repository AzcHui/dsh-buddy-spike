/**
 * dsh-buddy — CodeBuddy 模型目录单一真相源 + CLI 动态刷新。
 *
 * 背景：过去 `lib/llm.js`（dsh 目录适配器）与 `lib/client.js`（控制台
 * 下拉框）各自硬编码一份模型清单（同出 2026-09 的 `codebuddy --help`
 * 实测），物理重复、改一处忘一处，且 CLI 升级换清单后两处都会过时。
 *
 /**
 * 收敛到本模块后：
 *   - 默认清单 = 硬编码兜底（CLI 不可达时保证可用）；
 *   - `refreshCatalogFromCli()`（启动时自动一次 + 控制台手动刷新）：
 *     跑 `codebuddy --help`，解析 `--model` 行的
 *     `Currently supported: (a, b, c...)`，与现值比对；有增删则更新目录并落黑匣子
 *     `model-catalog-updated`；解析失败沿用现值。
 *   - 消费方：lib/llm.js（listModels/resolveModel）、lib/config.js
 *    （路由 GET/刷新端点）→ 控制台经 HTTP 动态取，浏览器侧零硬编码。
 *
 * ⚠️ 取证纪律（10-08 踩坑，见《换心手术全记录.md》第十八章）：本模块解析的清单
 * **取决于调用进程的环境**。`codebuddy --help` 会按登录态下发不同清单，
 * `CODEBUDDY_CONFIG_DIR` / `CLIENT_INFO_PRODUCT_VERSION` 是关键变量。
 * 手工验证或写兜底清单时，**必须在 dsh 自身环境（用户终端）下取证**，
 * 不要用 WorkBuddy/IDE 子进程的结果——那是另一个通道的清单。
 */
import { spawn } from 'node:child_process';
import { buddyLog } from './log.js';

/**
 * 运行时 CLI 可执行文件路径（设置页 buddy-llm-codebuddy.cliPath，留空=按 PATH 找
 * `codebuddy`）。llm.js 装载时从自身 Config 注入；显式传给 refreshCatalogFromCli
 * 的值优先。存这里而非读配置文件，是为了让 llm.js / buddy-loop 两个 dsh 条目
 * （各自独立 Config 命名空间）共用同一份目录来源。
 */
let runtimeCliPath = '';

/** 注入 CLI 路径（llm.js apply 时调用；传 falsy 即回落到 PATH 解析）。 */
export function setCatalogCliPath(value) {
    runtimeCliPath = typeof value === 'string' ? value.trim() : '';
}

/**
 * 兜底目录（codebuddy --help，2026-10-08 在 **dsh 自身环境**下实测）。
 *
 * ⚠️ 取证纪律：这份清单必须来自 **dsh 进程的环境**（用户终端），不能用
 * WorkBuddy/IDE 里测的结果。原因：`codebuddy --help` 的清单按登录态下发，
 * `CODEBUDDY_CONFIG_DIR` / `CLIENT_INFO_PRODUCT_VERSION` 会改变它——
 * WorkBuddy 通道下是 19 个，dsh 通道下是 17 个（详见《换心手术全记录.md》第十九章）。
 *
 * ⚠️ 另一个纪律：**清单随 CLI 版本变化**。2.156.0 时代 dsh 通道只有 16 个且无
 * `space-bunny`；升到 2.162.0 后变为 17 个并含 `space-bunny`（第二十章 A/B 实测）。
 * 所以升级 CLI 后要重新采样，不能沿用旧清单。
 *
 * 兜底只在 CLI 不可达/解析失败时兜一下，很快会被刷新结果覆盖；
 * 它不追求完整，追求"在当前 dsh 环境下确实可用"。
 */
const FALLBACK_CATALOG_IDS = [
    'hy4-preview', 'hy3', 'hy3-x',
    'space-bunny',
    'deepseek-v4.1-flash', 'deepseek-v4-pro',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
    'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6',
    'minimax-m3', 'minimax-m2.7',
];

/** 已知模型的人类可读名（新模型自动回退为 id 本身）。 */
const MODEL_NAMES = {
    'fast-model': 'Fast（快速）',
    'balanced-model': 'Balanced（均衡）',
    'deep-model': 'Deep（深度）',
    'glm-5.3': 'GLM-5.3',
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'glm-5.2': 'GLM-5.2',
    'glm-5.1': 'GLM-5.1',
    'glm-5v-turbo': 'GLM-5V-Turbo',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro',
    'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash',
    'kimi-k3-1': 'Kimi-K3.1',
    'kimi-k2.8-preview': 'Kimi-K2.8-Preview',
    'kimi-k2.7': 'Kimi-K2.7',
    'kimi-k2.6': 'Kimi-K2.6',
    'minimax-m3': 'MiniMax-M3',
    'minimax-m2.7': 'minimax-m2.7',
    'hy4-preview': 'HY4-Preview',
    'hy4-preview-f': 'HY4-Preview-F',
    'hy3': 'HY3',
    'hy3-x': 'HY3-X',
};

/**
 * 档位模型附用途描述（选择器里展示）。
 *
 * 注：`fast-model` / `balanced-model` / `deep-model` 是 WorkBuddy 通道的档位别名，
 * 在 **dsh 通道的 16 个权威清单里不存在**（10-08 实测，见全记录第十八章）。
 * 这里只作历史遗留的元数据兜底——它们不会出现在正常刷新的目录里；
 * 若日后 CLI 重新提供，会自动带上描述。
 */
const MODEL_DESCRIPTIONS = {
    'fast-model': '轻量快速，适合简单任务',
    'balanced-model': '速度与能力均衡的默认档',
    'deep-model': '深度推理，适合复杂任务',
};

/** id 列表 → 目录条目（保序、去重、补元数据）。 */
function buildCatalog(ids) {
    const seen = new Set();
    const entries = [];
    for (const id of ids) {
        const clean = String(id ?? '').trim();
        if (clean === '' || seen.has(clean)) continue;
        seen.add(clean);
        const name = MODEL_NAMES[clean] ?? clean;
        const description = MODEL_DESCRIPTIONS[clean];
        entries.push({ id: clean, name, ...(description === undefined ? {} : { description }) });
    }
    return entries;
}

/** 当前目录（module 单例；刷新后整体替换）。 */
let current = buildCatalog(FALLBACK_CATALOG_IDS);

/**
 * 曾被 CLI 确认存在过的模型 id（单调累积，永不删除）。
 *
 * 保护对象是**真实抖动**与 **CLI 升级换清单**：一旦拿到新清单，旧的 id 就永久
 * 记住；后续 CLI 本次没提到的历史 id 不删除，只降级为 `stale`（UI 仍可见、可选，
 * 描述里如实标注"CLI 当前清单未列出"）。CLI 重新提到时自动转正。
 *
 * ⚠️ 不要把它当成"环境差异"的补丁（10-08 曾误判，见全记录第十八章）：若差异来自
 * `CODEBUDDY_CONFIG_DIR` 等环境变量导致两个通道清单不同，那是两个**各自正确**的
 * 权威清单，不是抖动，不该靠累积掩盖。本模块只处理"同一环境下结果时多时少"。
 */
const seenIds = new Set(FALLBACK_CATALOG_IDS);

/** 读当前目录（消费方请勿改写返回值）。 */
export function getModelCatalog() {
    return current;
}

/** CLI 本次未提到、但历史上确认过的 id → 不再删除，只标记 stale。 */
function staleIds(present) {
    return [...seenIds].filter((id) => !present.has(id));
}

/**
 * 用一份模型 id 列表替换目录；与现值比对出增删，有变化才替换并落黑匣子。
 * @returns {{ changed: boolean, added: string[], removed: string[], catalog: Array }}
 */
export function applyCatalogIds(ids) {
    const fresh = buildCatalog(ids);
    if (fresh.length === 0) {
        // CLI 给出空清单视为异常输出，拒绝替换（保底目录继续服务）。
        return { changed: false, added: [], removed: [], catalog: current };
    }
    const present = new Set(fresh.map((model) => model.id));
    // 抖动保护：历史见过但本次没提到的 id 不删除，只降级为 stale。
    const dropped = staleIds(present);
    const next = dropped.length === 0
        ? fresh
        : [...fresh, ...buildCatalog(dropped).map((model) => ({ ...model, stale: true }))];
    for (const id of present) seenIds.add(id);

    const before = new Set(current.map((model) => model.id));
    const after = new Set(next.map((model) => model.id));
    const added = next.filter((model) => !before.has(model.id)).map((model) => model.id);
    const removed = current.filter((model) => !after.has(model.id)).map((model) => model.id);
    const changed = added.length > 0 || removed.length > 0;
    if (changed) {
        current = next;
        buddyLog('model-catalog-updated', { count: next.length, added, removed, stale: dropped });
    } else {
        // 清单相同也要刷新 stale 标记（CLI 可能把某模型转正回来）。
        current = next;
    }
    return { changed, added, removed, catalog: current };
}

/**
 * 跑 `codebuddy --help` 并解析 --model 行的官方支持清单，更新目录。
 * 永不 reject：CLI 缺失/超时/解析失败都返回 { ok: false, reason }，
 * 目录保持现值（控制台手动刷新时把 reason 回给用户）。
 *
 * @param options.cliPath 显式 CLI 可执行文件路径（设置页 buddy-llm-codebuddy.cliPath）；
 *   留空则按 PATH 解析 `codebuddy`。
 */
export function refreshCatalogFromCli({ timeoutMs = 20000, cliPath = '' } = {}) {
    const explicit = typeof cliPath === 'string' ? cliPath.trim() : '';
    const executable = explicit !== '' ? explicit : (runtimeCliPath !== '' ? runtimeCliPath : 'codebuddy');
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        let child;
        try {
            child = spawn(executable, ['--help'], { shell: true, windowsHide: true });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            buddyLog('model-catalog-refresh-failed', { reason });
            done({ ok: false, reason });
            return;
        }
        let stdout = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* 已退出 */ }
        }, timeoutMs);
        child.on('error', (error) => {
            clearTimeout(timer);
            const reason = error instanceof Error ? error.message : String(error);
            buddyLog('model-catalog-refresh-failed', { reason });
            done({ ok: false, reason });
        });
        child.on('close', () => {
            clearTimeout(timer);
            const match = stdout.match(/Currently supported:\s*\(([^)]*)\)/);
            if (!match) {
                buddyLog('model-catalog-refresh-failed', { reason: 'parse-failed' });
                done({ ok: false, reason: '未能从 codebuddy --help 解析出模型清单（CLI 输出格式可能已变化）' });
                return;
            }
            const ids = match[1].split(',').map((part) => part.trim()).filter(Boolean);
            done({ ok: true, ...applyCatalogIds(ids) });
        });
    });
}
