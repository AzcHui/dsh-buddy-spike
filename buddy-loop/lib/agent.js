/**
 * BuddyAgent — CodeBuddy-driven Agent driver for dsh.
 *
 * Implements the Agent contract (@deepseek-ai/dsh-agent) with CodeBuddy
 * (@tencent-ai/agent-sdk) as the ONLY brain: each turn is one SDK query(),
 * streamed into the dsh session as assistant frames. dsh keeps its UI,
 * session log, registry, and approval surfaces; no DeepSeek tokens are spent.
 *
 * Stage-1 simplifications (documented, intentional):
 *  - single flat queue (next-turn semantics only; steer == followup)
 *  - no durable inbox projection (queue lives in memory)
 *  - no tool bridging: CodeBuddy runs its own tools under its own approval
 */
import { agentEvents, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import {
    AssistantStreamAccumulator,
    BlockAssembler,
    LlmAttemptId,
    createAssistantMessage,
} from '@deepseek-ai/dsh-llm';
import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { query } from '@tencent-ai/agent-sdk';
import { buddyLog } from './log.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER = 'codebuddy';
const DEFAULT_MODEL = 'codebuddy';
/** CLI 启动看门狗：超时未产出任何消息则中止本次查询（防 resume 挂死）。 */
const INIT_WATCHDOG_MS = 60_000;

/** Flatten one dsh UserMessage into the plain prompt text CodeBuddy expects. */
function textOfUserMessage(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

/** Map CodeBuddy Usage → dsh TokenUsage. */
function mapUsage(usage) {
    if (!usage || typeof usage !== 'object') return undefined;
    const mapped = {};
    if (Number.isFinite(usage.input_tokens)) mapped.inputTokens = usage.input_tokens;
    if (Number.isFinite(usage.output_tokens)) mapped.outputTokens = usage.output_tokens;
    if (Number.isFinite(usage.cache_read_input_tokens)) mapped.cacheReadTokens = usage.cache_read_input_tokens;
    if (Number.isFinite(usage.cache_creation_input_tokens)) mapped.cacheWriteTokens = usage.cache_creation_input_tokens;
    return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/**
 * Minimal in-memory Inbox facade over BuddyAgent's queue.
 *
 * The web gateway (dsh-api-session-controller) and the goal round driver read
 * and mutate `agent.inbox` — the durable ReactLoopInbox lives inside
 * dsh-agent-loop and is not exported, so we satisfy the consumed surface:
 * nextTurn / nextStep / hasPending / replace / remove / prepend / append.
 * Messages arrive via send() already identified (frozen, with .id).
 */
class QueueInbox {
    agent;

    constructor(agent) {
        this.agent = agent;
    }

    _locate(id) {
        return this.agent.queue.findIndex((entry) => entry.message?.id === id);
    }

    /** Prompts awaiting individual turns. */
    get nextTurn() {
        return this.agent.queue.filter((entry) => entry.target === 'next-turn').map((entry) => entry.message);
    }

    /** Input awaiting the next step boundary (unused by the buddy driver). */
    get nextStep() {
        return this.agent.queue.filter((entry) => entry.target === 'next-step').map((entry) => entry.message);
    }

    /** Whether either pending-message list contains work. */
    get hasPending() {
        return this.agent.queue.length > 0;
    }

    replace(messageId, newMessage) {
        const index = this._locate(messageId);
        if (index === -1) return false;
        this.agent.queue[index] = { target: this.agent.queue[index].target, message: newMessage };
        return true;
    }

    remove(messageId) {
        const index = this._locate(messageId);
        if (index === -1) return false;
        this.agent.queue.splice(index, 1);
        return true;
    }

    prepend(target, message) {
        this.agent.queue.unshift({ target, message });
    }

    append(target, message) {
        this.agent.queue.push({ target, message });
    }

    clear() {
        this.agent.queue.length = 0;
    }
}

/** Drives one session with CodeBuddy as the single brain. */
export class BuddyAgent {
    loopCtx;
    id;
    options;
    session;
    /** The agent-scoped registration boundary; disposed after the driver exits. */
    scope;
    ctx;
    dispatch;

    phase;
    activityDone = Promise.resolve();
    /** Pending inputs (flat FIFO of { target, message }). */
    queue = [];
    assistantAttemptCounter = 0;
    /** Latest `model/selection` event value (UI 模型选择器的会话级选择). */
    selectedModel;
    /** Count of session events already scanned for model selections. */
    _selectionScanCount = 0;
    /** Last turn number used in this session（对齐原生 loop 的 turnBoundary 语义）. */
    _lastTurn = 0;
    /** CodeBuddy CLI 侧实际会话 id（init 消息回传，可能与 dsh 会话 id 不同）. */
    _buddyCliSessionId;
    /** Whether a CodeBuddy query has been issued in this process for this session. */
    _buddySessionLive = false;

    constructor(loopCtx, id, options, session) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options ?? {};
        this.session = session;
        this.dispatch = agentEvents(loopCtx, this);
        this.scope = createScope(loopCtx, this);
        this.ctx = this.scope.ctx;
        this.inbox = new QueueInbox(this);
        this.phase = { kind: 'idle' };
        this._lastTurn = this._recoverLastTurn();
        buddyLog('agent-created', { session: id, recoveredLastTurn: this._lastTurn });
    }

    /**
     * Recover the last used turn number from the session log. Native loop
     * reads the persisted turnBoundary projection; scanning the log directly
     * is self-contained and survives projection-cache loss.
     */
    _recoverLastTurn() {
        try {
            const events = this.session.snapshotEvents(SessionLogOffset(0));
            let max = 0;
            for (const event of events) {
                if (event.type === 'turn/start'
                    && Number.isFinite(event.data?.turn)
                    && event.data.turn > max) {
                    max = event.data.turn;
                }
            }
            return max;
        } catch {
            return 0; // 日志不可用时从 1 起编，绝不阻塞回合
        }
    }

    /**
     * 检查 CodeBuddy CLI 侧是否存有该会话 id 的转录
     * （~/.codebuddy/projects/<cwd-slug>/<session-id>.jsonl）。
     * resume 不存在的转录会让 CLI 静默挂死（不报错），因此 resume 前必须校验。
     * 布局探测失败时返回 false——降级为新建会话，宁可失忆也不挂死。
     */
    _codebuddyTranscriptExists(sessionId) {
        try {
            const projectsDir = path.join(os.homedir(), '.codebuddy', 'projects');
            for (const entry of fs.readdirSync(projectsDir)) {
                if (fs.existsSync(path.join(projectsDir, entry, `${sessionId}.jsonl`))) return true;
            }
        } catch { /* 布局变化/无目录：放弃续聊 */ }
        return false;
    }

    get status() {
        return this.phase.kind === 'idle' ? 'idle' : 'running';
    }

    /** Commit a phase and publish its externally visible status transition. */
    setPhase(next) {
        const previous = this.status;
        this.phase = next;
        const status = this.status;
        if (status !== previous) this.dispatch.emit('agent/status', { status });
    }

    send(message, target, wakeup) {
        this.queue.push({ target: target ?? 'next-turn', message });
        if (wakeup) this.wakeDriver();
    }

    followup(input) {
        this.send(input, 'next-turn', true);
    }

    /** Stage-1 simplification: steering mid-run is queued as the next turn. */
    steer(input) {
        this.send(input, 'next-turn', true);
    }

    inject(input) {
        this.send(input, 'next-turn', false);
    }

    cancel(cause, options = {}) {
        if (!options.keepInbox) this.queue.length = 0;
        if (this.phase.kind !== 'idle') {
            this.phase.abort.abort(cause ?? new Error(`agent "${this.id}" canceled`));
        }
    }

    async runMaintenance(job) {
        if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`);
        const done = Promise.withResolvers();
        this.activityDone = done.promise;
        this.setPhase({ kind: 'maintenance' });
        try {
            return await job(new AbortController().signal);
        } finally {
            this.setPhase({ kind: 'idle' });
            if (this.queue.length > 0) this.wakeDriver();
            done.resolve();
        }
    }

    async whenIdle() {
        let activity;
        do {
            await (activity = this.activityDone);
        } while (activity !== this.activityDone);
    }

    /** Start one driver, or latch its wake behind an active run. */
    wakeDriver() {
        if (this.phase.kind !== 'idle') {
            if (this.phase.kind === 'running') this.phase.wakeRequested = true;
            return;
        }
        const driver = Promise.withResolvers();
        this.activityDone = driver.promise;
        // turn 起点延续会话已有编号（原生 loop 从 turnBoundary 投影恢复 lastTurn；
        // 硬编码 0 会让每个新回合都重数 turn:1，UI 按 turn 组装时被撞号击穿）
        this.setPhase({ kind: 'running', abort: new AbortController(), turn: this._lastTurn, wakeRequested: false });
        this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
    }

    async kick() {
        try {
            while (this.queue.length > 0 && !this.phase.abort.signal.aborted) {
                await this.turn();
            }
        } catch (error) {
            // Driver containment: the failure already surfaced at its boundary.
        } finally {
            if (this.phase.kind === 'running') {
                const { turn, wakeRequested } = this.phase;
                this._lastTurn = Math.max(this._lastTurn, turn);
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.queue.length > 0) this.wakeDriver();
            }
        }
    }

    /**
     * 吸收自上次扫描以来的新会话事件，取最新的 `model/selection`。
     * UI 模型选择器经 session.selectModel 落为该会话事件（session-controller
     * selectForNextRequest → session.append('model/selection')），buddy-loop
     * 在每个回合开始时增量扫描截获——选中即对下一回合生效。
     */
    _absorbModelSelection() {
        let fresh;
        try {
            fresh = this.session.snapshotEvents(SessionLogOffset(this._selectionScanCount));
        } catch {
            return; // 快照不可用时保持现状，绝不阻塞回合
        }
        this._selectionScanCount += fresh.length;
        for (const event of fresh) {
            if (event?.type !== 'model/selection') continue;
            const value = event.value ?? event.data;
            if (
                value && typeof value === 'object'
                && typeof value.provider === 'string' && typeof value.model === 'string'
            ) {
                this.selectedModel = value;
                buddyLog('model-selection', { session: this.session.id, provider: value.provider, model: value.model });
            }
        }
    }

    /**
     * 解析本次查询实际使用的模型，优先级：
     * UI 会话选择（provider === 'codebuddy'）> 控制台配置 > CLI 默认。
     * 非 codebuddy 路由的选择（如 deepseek-official）无法由 CodeBuddy SDK
     * 承载，保持现状不跟随。
     */
    _resolveModel() {
        const selection = this.selectedModel;
        if (selection && selection.provider === PROVIDER && selection.model !== '') {
            return selection.model;
        }
        return this.options.buddyModel ?? this.options.model ?? DEFAULT_MODEL;
    }

    /** One turn = claim one queued user message and run one CodeBuddy query. */
    async turn() {
        const phase = this.phase;
        const signal = phase.abort.signal;
        const turn = phase.turn + 1;
        phase.turn = turn;
        this._absorbModelSelection();
        this.session.append('turn/start', { turn });
        buddyLog('turn-start', { session: this.session.id, turn });
        const entry = this.queue.shift();
        const message = entry?.message;
        let outcome;
        try {
            this.session.append('user/message', message, { surfaceOp: 'append' });
            const step = 1;
            this.session.append('step/start', { turn, step });
            try {
                await this.runQuery(turn, step, message, signal);
            } finally {
                this.session.append('step/end', { turn, step });
            }
            outcome = { kind: 'completed' };
        } catch (error) {
            if (signal.aborted) {
                outcome = { kind: 'aborted', reason: signal.reason };
            } else {
                outcome = {
                    kind: 'error',
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                        code: 'CODEBUDDY_DRIVER',
                    },
                };
                this.dispatch.emit('agent/error', { turn, step: 1, error });
            }
        } finally {
            try {
                this.session.append('turn/end', { turn, reason: outcome });
                buddyLog('turn-end', { session: this.session.id, turn, outcome: outcome.kind });
            } catch (endError) {
                this.dispatch.emit('agent/error', { turn, step: 1, error: endError });
            }
        }
    }

    /**
     * One CodeBuddy query streamed into the session as one assistant attempt.
     * Text/reasoning deltas stream live; the durable assistant/message commits
     * once the SDK result arrives.
     */
    async runQuery(turn, step, message, signal) {
        const prompt = textOfUserMessage(message);
        const attemptId = LlmAttemptId(`${this.session.id}:${++this.assistantAttemptCounter}`);
        const accumulator = new AssistantStreamAccumulator();
        const assembler = new BlockAssembler();
        let revision = 0;
        let index = 0;
        let streamedText = false;
        let lastAssistantText = '';
        let usage;
        let failure;
        const nextRevision = () => ++revision;
        const pushChunk = (chunk) => {
            const timed = accumulator.push({ time: Date.now(), chunk });
            assembler.push(timed.chunk);
            this.dispatch.emit('agent/assistant-stream', {
                frame: {
                    type: 'chunk',
                    attemptId,
                    revision: nextRevision(),
                    index: index++,
                    time: timed.time,
                    chunk: timed.chunk,
                },
            });
        };
        this.dispatch.emit('agent/assistant-stream', {
            frame: { type: 'start', attemptId, revision: nextRevision(), turn, step },
        });
        // dsh 会话 id 直接作为 CodeBuddy 会话 id（1:1 映射，跨进程重启可续）：
        // 会话已有历史（进程重启恢复，或本进程已发出过查询）且 CLI 侧转录确实
        // 存在时 resume 续聊；否则以该 id 新建。resume 不存在的转录 CLI 会静默
        // 挂死而不是报错，所以必须前置校验转录文件（bug 09f1927 实测踩坑）。
        const wantResume = this._buddySessionLive || this._lastTurn > 0;
        const resumeTarget = this._buddyCliSessionId ?? this.session.id;
        const resumeId = wantResume && this._codebuddyTranscriptExists(resumeTarget)
            ? resumeTarget
            : undefined;
        const consume = async (resume) => {
            const controller = new AbortController();
            const onOuterAbort = () => controller.abort(signal.reason);
            if (signal.aborted) controller.abort(signal.reason);
            else signal.addEventListener('abort', onOuterAbort, { once: true });
            // 启动看门狗：收到 CLI 第一条消息即解除；超时则中止（转降级路径）
            let watchdog = setTimeout(
                () => controller.abort(new Error(`CodeBuddy CLI ${INIT_WATCHDOG_MS / 1000}s 无响应，中止本次查询`)),
                INIT_WATCHDOG_MS,
            );
            const disarm = () => {
                clearTimeout(watchdog);
                watchdog = undefined;
            };
            try {
                const model = this._resolveModel();
                buddyLog('query-start', {
                    session: this.session.id,
                    turn,
                    model,
                    mode: resume === undefined ? 'create' : 'resume',
                    resumeId: resume,
                    promptLen: prompt.length,
                });
                const conversation = query({
                    prompt,
                    options: {
                        maxTurns: this.options.buddyMaxTurns ?? 10,
                        includePartialMessages: true,
                        model,
                        ...(resume === undefined ? { sessionId: this.session.id } : { resume }),
                        ...(this.options.buddyCwd === undefined ? {} : { cwd: this.options.buddyCwd }),
                        ...(this.options.buddyThinking === undefined ? {} : { thinking: this.options.buddyThinking }),
                        ...(this.options.buddyEnv === undefined ? {} : { env: this.options.buddyEnv }),
                        ...(this.options.buddySystemPrompt === undefined ? {} : { systemPrompt: this.options.buddySystemPrompt }),
                        abortController: controller,
                    },
                });
                for await (const msg of conversation) {
                    signal.throwIfAborted();
                    disarm();
                    if (msg.type === 'system' && msg.subtype === 'init') {
                        // 记录 CLI 侧实际会话 id，后续 resume 以它为准
                        this._buddyCliSessionId = msg.session_id;
                        buddyLog('cli-init', { session: this.session.id, cliSessionId: msg.session_id });
                    } else if (msg.type === 'stream_event') {
                        const event = msg.event;
                        const delta = event?.delta;
                        if (event?.type === 'content_block_delta' && delta) {
                            if (delta.type === 'text_delta' && delta.text) {
                                if (!streamedText) {
                                    buddyLog('first-chunk', { session: this.session.id, turn });
                                }
                                streamedText = true;
                            pushChunk({ type: 'text-delta', index: 0, text: delta.text });
                        } else if (delta.type === 'thinking_delta' && delta.thinking) {
                            pushChunk({ type: 'reasoning-delta', index: 1, text: delta.thinking });
                        }
                    }
                } else if (msg.type === 'assistant') {
                    // Complete assistant message: keep its text as fallback for
                    // deployments without partial streaming.
                    const blocks = msg.message?.content;
                    if (Array.isArray(blocks)) {
                        const text = blocks
                            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                            .map((block) => block.text)
                            .join('');
                        if (text !== '') lastAssistantText = text;
                    }
                    if (msg.error) failure ??= { message: String(msg.error), code: 'CODEBUDDY_ERROR' };
                } else if (msg.type === 'result') {
                    usage = mapUsage(msg.usage) ?? usage;
                    buddyLog('query-result', {
                        session: this.session.id,
                        turn,
                        subtype: msg.subtype,
                        isError: msg.is_error === true,
                        ...(usage === undefined ? {} : { usage }),
                    });
                    if (msg.subtype !== 'success' || msg.is_error === true) {
                        failure ??= {
                            message: Array.isArray(msg.errors) && msg.errors.length > 0
                                ? msg.errors.join('; ')
                                : `CodeBuddy query failed: ${msg.subtype}`,
                            code: 'CODEBUDDY_ERROR',
                        };
                    }
                }
                }
            } finally {
                if (watchdog !== undefined) clearTimeout(watchdog);
                signal.removeEventListener('abort', onOuterAbort);
            }
        };
        const attempt = async (resume) => {
            try {
                await consume(resume);
                return true;
            } catch (error) {
                buddyLog('query-failure', {
                    session: this.session.id,
                    turn,
                    mode: resume === undefined ? 'create' : 'resume',
                    message: error instanceof Error ? error.message : String(error),
                });
                if (!signal.aborted && failure === undefined) {
                    failure = {
                        message: error instanceof Error ? error.message : String(error),
                        code: 'CODEBUDDY_QUERY',
                    };
                }
                return false;
            }
        };
        const ok = await attempt(resumeId);
        // resume 失败且没有任何流式输出 → CodeBuddy 侧转录已失效（被清理，
        // 或本修复之前的历史没有对应转录），降级为新建会话重试一次（无损重试）。
        if (!ok && resumeId !== undefined && !signal.aborted && !streamedText) {
            buddyLog('query-fallback', { session: this.session.id, turn, from: resumeId });
            failure = undefined;
            await attempt(undefined);
        }
        this._buddySessionLive = true;
        signal.throwIfAborted();
        // Fallback: no partial deltas arrived — commit the final text as one delta.
        if (!streamedText && lastAssistantText !== '') {
            pushChunk({ type: 'text-delta', index: 0, text: lastAssistantText });
        }
        // Surface driver-level failures visibly: an empty assistant message would
        // look like a silent no-op in the UI.
        if (!streamedText && lastAssistantText === '' && failure !== undefined) {
            pushChunk({ type: 'text-delta', index: 0, text: `[dsh-buddy-loop] CodeBuddy 调用失败：${failure.message}` });
        }
        if (usage !== undefined) pushChunk({ type: 'usage', usage });
        pushChunk({
            type: 'finish',
            reason: failure === undefined
                ? { kind: 'stop' }
                : { kind: 'error', failure },
        });
        const assistantMessage = createAssistantMessage({
            content: assembler.blocks(),
            source: {
                provider: PROVIDER,
                model: this._resolveModel(),
            },
        });
        const seq = this.session.append('assistant/message', {
            turn,
            step,
            message: assistantMessage,
            ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
            stream: accumulator.snapshot(),
        }, { surfaceOp: 'append' }).seq;
        this.dispatch.emit('agent/assistant-stream', {
            frame: {
                type: 'end',
                attemptId,
                revision: nextRevision(),
                index,
                outcome: { kind: 'committed', eventType: 'assistant/message', seq },
            },
        });
        if (failure !== undefined) {
            const error = new Error(failure.message);
            error.code = failure.code;
            this.dispatch.emit('agent/error', { turn, step, error });
        }
    }
}

/** Re-emit one contained agent notification without retaining a dispatcher. */
export { emitAgentEvent };
