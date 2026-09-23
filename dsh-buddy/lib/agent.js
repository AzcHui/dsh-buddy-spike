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
import { createScope } from '@deepseek-ai/dsh-scope';
import { query } from '@tencent-ai/agent-sdk';

const PROVIDER = 'codebuddy';
const DEFAULT_MODEL = 'codebuddy';

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
        this.setPhase({ kind: 'running', abort: new AbortController(), turn: 0, wakeRequested: false });
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
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.queue.length > 0) this.wakeDriver();
            }
        }
    }

    /** One turn = claim one queued user message and run one CodeBuddy query. */
    async turn() {
        const phase = this.phase;
        const signal = phase.abort.signal;
        const turn = phase.turn + 1;
        phase.turn = turn;
        this.session.append('turn/start', { turn });
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
        try {
            const conversation = query({
                prompt,
                options: {
                    maxTurns: this.options.buddyMaxTurns ?? 10,
                    includePartialMessages: true,
                    ...(this.options.buddyCwd === undefined ? {} : { cwd: this.options.buddyCwd }),
                },
            });
            for await (const msg of conversation) {
                signal.throwIfAborted();
                if (msg.type === 'stream_event') {
                    const event = msg.event;
                    const delta = event?.delta;
                    if (event?.type === 'content_block_delta' && delta) {
                        if (delta.type === 'text_delta' && delta.text) {
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
        } catch (error) {
            if (!signal.aborted && failure === undefined) {
                failure = {
                    message: error instanceof Error ? error.message : String(error),
                    code: 'CODEBUDDY_QUERY',
                };
            }
        }
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
                model: this.options.model ?? DEFAULT_MODEL,
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
