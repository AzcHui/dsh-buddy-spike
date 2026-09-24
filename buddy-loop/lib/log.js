/**
 * buddy 运行日志 —— 换心排错的"黑匣子"。
 *
 * 设计目标（09-24 复盘）：turn 撞号、失忆开局、resume 挂死三个 bug 都是
 * "出事后反推"。有了这份日志，排障第一步直接看它，精确锁定哪一步出问题。
 *
 * 格式：JSON Lines（一行一个 JSON 对象），字段：
 *   t      ISO 时间
 *   pid    进程 id（区分 dsh web 重启前后）
 *   event  事件名（query-start / cli-init / turn-end / query-failure ...）
 *   其余为事件详情（session / turn / model / mode / resumeId / ...）
 *
 * 位置：$DSH_HOME（缺省 ~/.dsh）/logs/dsh-buddy.log；超过 5MB 轮转为 .old。
 * 铁律：任何日志失败都静默吞掉——日志永远不能弄死对话。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

function logFilePath() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'logs', 'dsh-buddy.log');
}

/**
 * @param {string} event 事件名（点分小写，如 'query-start'）
 * @param {object} [detail] 事件详情，值必须是可 JSON 序列化的
 */
export function buddyLog(event, detail = {}) {
    try {
        const file = logFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > MAX_BYTES) {
                fs.renameSync(file, `${file}.old`); // 单文件轮转，够用
            }
        } catch { /* 文件不存在/被占用：直接写 */ }
        const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...detail });
        fs.appendFileSync(file, line + '\n');
    } catch { /* 日志失败绝不影响对话 */ }
}
