/**
 * dsh-buddy-loop — 遥控器配置存储与 HTTP 路由（服务端 half）。
 *
 * "电视附赠的遥控器"：CodeBuddy 私有配置（model/thinking/maxTurns/cwd/env/
 * systemPrompt）独立于 dsh 自身设置，由设置页里的遥控器面板通过同源路由
 * 读写，落盘在包目录的 buddy-config.json。BuddyLoop 每次建代理时读取最新
 * 配置，因此保存后对新会话即时生效，无需重启。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 遥控器同源路由。 */
export const BUDDY_CONFIG_ROUTE = '/api/buddy/config';

/** 配置文件位置：包根目录（与 lib/ 同级），随包走、随 profile 迁移。 */
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'buddy-config.json');

const THINKING_TYPES = new Set(['adaptive', 'enabled', 'disabled']);
const MAX_BODY_BYTES = 64 * 1024;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验并归一化一份原始配置。
 * 只认识 model/maxTurns/cwd/thinking/env/systemPrompt 六个字段；未提供的
 * 字段不出现在产物里（= 移除该项覆盖，回退 CLI 默认）。
 * @returns {{ config: object, errors: string[] }}
 */
export function normalizeBuddyConfig(raw) {
    const config = {};
    const errors = [];
    if (raw === undefined || raw === null) return { config, errors };
    if (!isPlainObject(raw)) return { config, errors: ['配置必须是一个 JSON 对象'] };
    const { model, maxTurns, cwd, thinking, env, systemPrompt, ...rest } = raw;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) errors.push(`未知字段：${unknown.join(', ')}`);
    if (model !== undefined) {
        if (typeof model !== 'string' || model.trim() === '') errors.push('model 必须是非空字符串');
        else config.model = model.trim();
    }
    if (maxTurns !== undefined) {
        const turns = Number(maxTurns);
        if (!Number.isInteger(turns) || turns < 1) errors.push('maxTurns 必须是 >= 1 的整数');
        else config.maxTurns = turns;
    }
    if (cwd !== undefined) {
        if (typeof cwd !== 'string' || cwd.trim() === '') errors.push('cwd 必须是非空字符串');
        else config.cwd = cwd.trim();
    }
    if (thinking !== undefined) {
        if (!isPlainObject(thinking) || !THINKING_TYPES.has(thinking.type)) {
            errors.push('thinking 必须是 { type: adaptive|enabled|disabled }');
        } else if (thinking.type === 'enabled') {
            const budget = thinking.budgetTokens === undefined ? 32000 : Number(thinking.budgetTokens);
            if (!Number.isInteger(budget) || budget < 1) errors.push('thinking.budgetTokens 必须是 >= 1 的整数');
            else config.thinking = { type: 'enabled', budgetTokens: budget };
        } else {
            config.thinking = { type: thinking.type };
        }
    }
    if (env !== undefined) {
        if (!isPlainObject(env)) {
            errors.push('env 必须是 KEY=VALUE 对象');
        } else {
            const clean = {};
            let bad = false;
            for (const [key, value] of Object.entries(env)) {
                if (typeof key !== 'string' || key.trim() === '' || typeof value !== 'string') { bad = true; break; }
                clean[key.trim()] = value;
            }
            if (bad) errors.push('env 的键必须是非空字符串、值必须是字符串');
            else if (Object.keys(clean).length > 0) config.env = clean;
        }
    }
    if (systemPrompt !== undefined) {
        // wire 形态：字符串 = 完全覆盖；{ mode:'append', text } = 追加到默认提示词。
        if (typeof systemPrompt === 'string' && systemPrompt.trim() !== '') {
            config.systemPrompt = systemPrompt.trim();
        } else if (isPlainObject(systemPrompt) && typeof systemPrompt.text === 'string' && systemPrompt.text.trim() !== '') {
            config.systemPrompt = systemPrompt.mode === 'append'
                ? { append: systemPrompt.text.trim() }
                : systemPrompt.text.trim();
        } else {
            errors.push('systemPrompt 必须是非空字符串或 { mode, text }');
        }
    }
    return { config, errors };
}

/** 读取落盘配置；文件缺失或损坏时按空配置继续（遥控器覆盖项全部回退默认）。 */
export function loadBuddyConfig() {
    try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
        return normalizeBuddyConfig(parsed).config;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[buddy-loop] 读取 ${CONFIG_PATH} 失败，按空配置继续: ${error instanceof Error ? error.message : error}`);
        }
        return {};
    }
}

function atomicWrite(text) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const temporary = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, text, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, CONFIG_PATH);
    } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
}

/** 校验并落盘；校验失败抛错（错误信息直接回给面板）。 */
export function saveBuddyConfig(raw) {
    const { config, errors } = normalizeBuddyConfig(raw);
    if (errors.length > 0) throw new Error(errors.join('; '));
    atomicWrite(`${JSON.stringify(config, null, 2)}\n`);
    return config;
}

function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '') return false;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body-too-large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('invalid-json'));
            }
        });
        req.on('error', reject);
    });
}

/** 遥控器配置路由：GET 读取、POST 校验落盘。 */
export function makeBuddyConfigRoute() {
    return {
        kind: 'exact',
        path: BUDDY_CONFIG_ROUTE,
        async handler(req, res) {
            const reply = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(body));
            };
            if (!sameOrigin(req)) {
                reply(403, { ok: false, error: 'cross-site-request-rejected' });
                return;
            }
            try {
                if (req.method === 'GET') {
                    reply(200, { ok: true, config: loadBuddyConfig() });
                    return;
                }
                if (req.method !== 'POST') {
                    reply(405, { ok: false, error: 'method-not-allowed' });
                    return;
                }
                const raw = await readBody(req);
                const config = saveBuddyConfig(raw);
                reply(200, { ok: true, config });
            } catch (error) {
                reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    };
}
