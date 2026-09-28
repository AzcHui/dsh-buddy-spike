/**
 * dsh-buddy — CodeBuddy 模型目录单一真相源 + CLI 动态刷新。
 *
 * 背景：过去 `lib/llm.js`（dsh 目录适配器）与 `lib/client.js`（控制台
 * 下拉框）各自硬编码一份模型清单（同出 2026-09 的 `codebuddy --help`
 * 实测），物理重复、改一处忘一处，且 CLI 升级换清单后两处都会过时。
 *
 * 收敛到本模块后：
 *   - 默认清单 = 硬编码兜底（CLI 不可达时保证可用）；
 *   - `refreshCatalogFromCli()`（启动时自动一次 + 控制台手动刷新）：
 *     跑 `codebuddy --help`，解析 `--model` 行的
 *     `Currently supported: (a, b, c...)`，与现值比对；有增删则原子
 *     替换目录并落黑匣子 `model-catalog-updated`；解析失败沿用现值。
 *   - 消费方：lib/llm.js（listModels/resolveModel）、lib/config.js
 *    （路由 GET/刷新端点）→ 控制台经 HTTP 动态取，浏览器侧零硬编码。
 */
import { spawn } from 'node:child_process';
import { buddyLog } from './log.js';

/** 兜底目录（codebuddy --help，2026-09-24 实测）。 */
const FALLBACK_CATALOG_IDS = [
    'fast-model', 'balanced-model', 'deep-model',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
    'deepseek-v4-pro', 'deepseek-v4.1-flash',
    'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6',
    'minimax-m3', 'hy4-preview', 'hy4-preview-f', 'hy3', 'hy3-x',
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
    'hy4-preview': 'HY4-Preview',
    'hy4-preview-f': 'HY4-Preview-F',
    'hy3': 'HY3',
    'hy3-x': 'HY3-X',
};

/** 档位模型附用途描述（选择器里展示）。 */
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

/** 读当前目录（消费方请勿改写返回值）。 */
export function getModelCatalog() {
    return current;
}

/**
 * 用一份模型 id 列表替换目录；与现值比对出增删，有变化才替换并落黑匣子。
 * @returns {{ changed: boolean, added: string[], removed: string[], catalog: Array }}
 */
export function applyCatalogIds(ids) {
    const next = buildCatalog(ids);
    if (next.length === 0) {
        // CLI 给出空清单视为异常输出，拒绝替换（保底目录继续服务）。
        return { changed: false, added: [], removed: [], catalog: current };
    }
    const before = new Set(current.map((model) => model.id));
    const after = new Set(next.map((model) => model.id));
    const added = next.filter((model) => !before.has(model.id)).map((model) => model.id);
    const removed = current.filter((model) => !after.has(model.id)).map((model) => model.id);
    const changed = added.length > 0 || removed.length > 0;
    if (changed) {
        current = next;
        buddyLog('model-catalog-updated', { count: next.length, added, removed });
    }
    return { changed, added, removed, catalog: current };
}

/**
 * 跑 `codebuddy --help` 并解析 --model 行的官方支持清单，更新目录。
 * 永不 reject：CLI 缺失/超时/解析失败都返回 { ok: false, reason }，
 * 目录保持现值（控制台手动刷新时把 reason 回给用户）。
 */
export function refreshCatalogFromCli({ timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        let child;
        try {
            child = spawn('codebuddy', ['--help'], { shell: true, windowsHide: true });
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
