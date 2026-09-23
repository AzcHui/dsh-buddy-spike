/**
 * dsh-buddy-loop — CodeBuddy-powered AgentFactory replacement for
 * @deepseek-ai/dsh-agent-loop.
 *
 * Registers as the dsh agent factory (ctx.agents.setFactory) so every session
 * the dsh UI/API creates is driven by CodeBuddy (your Tencent CodeBuddy plan
 * quota) instead of the DeepSeek adapter.
 *
 * Patch wiring (buddy.patch.yml): the stock `agent-loop` row is disabled and
 * this plugin is inserted as its own row — patch rows cannot rename targets,
 * and the loader imports `./buddy-loop/lib/index.js` relative to the patch.
 *
 * Durability: when a sessionPersistence backend is mounted, create takes the
 * new session's write ownership (persistence.create) and resume reopens the
 * stored log (persistence.open); the handle doubles as the live event router,
 * so it stays open for the agent's lifetime and closes in dispose.
 */
import { Service } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { SessionLogOffset, SessionPreparation, interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { BuddyAgent } from './agent.js';

/** Service name kept as 'agentLoop' so sibling services keep resolving. */
const SERVICE_NAME = 'agentLoop';

/** Concrete agent factory and driver service. */
var BuddyLoop = class BuddyLoop extends Service {
    static inject = ['agents', 'sessions'];
    /** Runtime schema — a compatible subset of dsh-agent-loop's config. */
    static Config = z.object({
        buddyMaxTurns: z.number().default(10),
        agents: z.array(z.object({
            id: z.string().required(),
            sessionId: z.string(),
            cwd: z.string(),
            buddyMaxTurns: z.number(),
        })).default([]),
    });

    config;

    constructor(ctx, config) {
        super(ctx, SERVICE_NAME);
        this.config = config ?? {};
        // The registry re-traces createAgent through the CALLER's context, whose
        // inject map lacks our dependencies. Keep the real plugin ctx in a
        // non-intercepted instance field and use it for service access.
        Object.defineProperty(this, '_loopCtx', { value: ctx, enumerable: false, writable: false });
        ctx.effect(() => ctx.agents.setFactory(this), 'buddyLoop.setFactory()');
        for (const entry of this.config.agents ?? []) {
            const { id, sessionId, cwd, buddyMaxTurns, ...options } = entry;
            const configuredId = sessionId ?? id;
            this.create(configuredId, { ...options, buddyMaxTurns, ...(cwd === undefined ? {} : { buddyCwd: cwd }) })
                .then(() => undefined, (error) => {
                    this.ctx.logger.warn(`buddy-loop: config-driven create of "${configuredId}" failed: ${error instanceof Error ? error.message : String(error)}`);
                });
        }
    }

    /** Flush events appended before publication; they never re-emit via session/event. */
    async _appendUnstoredSuffix(stored, session) {
        if (stored === undefined) return;
        const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
        if (suffix.length > 0) await stored.handle.append(suffix);
        stored.storedCount += suffix.length;
    }

    /**
     * Create an agent + session under one caller-supplied identity.
     * Mirrors AgentLoop.createAgent's option surface: { sessionId, seed, meta,
     * inheritedEventCount, agentOptions, setup, signal, parentAgent }.
     */
    async createAgent(ownerCtx, options) {
        const loopCtx = this._loopCtx ?? this.ctx;
        const id = options.sessionId;
        const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
            ...(options.seed === undefined ? {} : { seed: options.seed }),
            ...(options.meta === undefined ? {} : { meta: options.meta }),
            ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        }));
        let stored;
        try {
            const session = preparation.session;
            // Take the fresh session's write ownership so appends persist.
            const persistence = loopCtx.get('sessionPersistence');
            if (persistence !== undefined) {
                stored = {
                    handle: await persistence.create(session.header, {
                        inheritedEventCount: session.inheritedEventCount,
                    }),
                    storedCount: 0,
                };
            }
            const agentOptions = { buddyMaxTurns: this.config.buddyMaxTurns, ...(options.agentOptions ?? {}) };
            const provisional = new BuddyAgent(loopCtx, id, agentOptions, session);
            try {
                const setupResult = await options.setup?.(provisional.ctx, provisional);
                setupResult?.commit?.();
                await this._appendUnstoredSuffix(stored, session);
                return this._publishBuilt(loopCtx, id, provisional, options.parentAgent, stored, 'startup');
            } catch (error) {
                try { provisional.cancel({ kind: 'disposed' }); } catch { /* containment */ }
                try { await provisional.scope.dispose(); } catch { /* containment */ }
                throw error;
            }
        } catch (error) {
            try { await stored?.handle.close(); } catch { /* containment */ }
            preparation[Symbol.dispose]?.();
            throw error;
        }
    }

    /** Announce an already-constructed driver and attach its dispose. */
    _publishBuilt(loopCtx, id, agent, parentAgent, stored, source) {
        const detachSession = agent.ctx.sessions.enter(agent.session);
        const detachAgent = loopCtx.agents.enter(agent, parentAgent);
        agent.ctx.sessions.announce(agent.session);
        loopCtx.agents.announce(agent);
        emitAgentEvent(loopCtx, agent, 'agent/session-start', { source });
        let disposed = false;
        const dispose = async () => {
            if (disposed) return;
            disposed = true;
            try {
                agent.cancel({ kind: 'disposed' });
                await agent.whenIdle();
            } catch { /* containment */ }
            try {
                detachAgent?.();
                detachSession?.();
                await agent.scope.dispose();
            } catch { /* containment */ }
            try {
                await stored?.handle.close();
            } catch { /* containment */ }
        };
        return { agent, dispose };
    }

    /**
     * Resume a stored session and drive it with CodeBuddy.
     * Mirrors AgentLoop.resumeWith: open write handle → cold read → close any
     * turn an interruption left dangling → seed the session with history →
     * publish. The reopened handle stays open so new appends persist.
     */
    async resume(ownerCtx, options) {
        const loopCtx = this._loopCtx ?? this.ctx;
        const id = options.resumeSessionId;
        const persistence = loopCtx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new Error('dsh-buddy-loop: cannot resume: session persistence is not configured');
        }
        const handle = await persistence.open(id, 'write');
        let preparation;
        try {
            const coldRead = await handle.read(0, undefined);
            const persisted = coldRead.events;
            const closers = interruptedTurnClosers(persisted);
            if (closers.length > 0) await handle.append(closers);
            preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
                seed: [...persisted, ...closers],
                meta: structuredClone(handle.header),
                inheritedEventCount: handle.inheritedEventCount,
                eventState: coldRead.eventState,
            }));
            const session = preparation.session;
            const stored = { handle, storedCount: persisted.length + closers.length };
            const agentOptions = { buddyMaxTurns: this.config.buddyMaxTurns, ...(options.agentOptions ?? {}) };
            const provisional = new BuddyAgent(loopCtx, id, agentOptions, session);
            try {
                const setupResult = await options.setup?.(provisional.ctx, provisional);
                setupResult?.commit?.();
                await this._appendUnstoredSuffix(stored, session);
                return this._publishBuilt(loopCtx, id, provisional, options.parentAgent, stored, 'resume');
            } catch (error) {
                try { provisional.cancel({ kind: 'disposed' }); } catch { /* containment */ }
                try { await provisional.scope.dispose(); } catch { /* containment */ }
                throw error;
            }
        } catch (error) {
            try { await handle.close(); } catch { /* containment */ }
            preparation?.[Symbol.dispose]?.();
            throw error;
        }
    }
};

export { BuddyLoop };
export default BuddyLoop;
