/**
 * Stage-1 minimal circuit test for dsh-buddy-loop.
 *
 * Boots a minimal Cordis app with just the services BuddyLoop needs,
 * creates one agent through the registry (factory delegation), sends one
 * message, and verifies the session log contains a CodeBuddy answer.
 *
 * Run inside dsh-recon (deps resolve from its node_modules):
 *   node run-buddy.mjs
 */
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import InvariantsService from '@deepseek-ai/dsh-invariants';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant';
import SessionService from '@deepseek-ai/dsh-session';
import * as agentInvariant from '@deepseek-ai/dsh-agent/invariant';
import AgentService from '@deepseek-ai/dsh-agent';
import BuddyLoop from 'dsh-buddy-loop';

const SESSION_ID = 'buddy-stage1-test';

const app = new Context();

// Sequential mounting: each plugin fiber must reach state 2 (active) before
// the next mounts — service impl lookups are strict about fiber state.
const fibers = {};
fibers.invariants = app.plugin(InvariantsService);
fibers.typert = app.plugin(TypertRegistry);
fibers.sessionProjection = app.plugin(SessionProjection);
fibers.session = app.plugin(SessionService);
fibers.sessionInvariant = app.plugin(sessionInvariant);
fibers.agent = app.plugin(AgentService);
fibers.agentInvariant = app.plugin(agentInvariant);
for (const [name, fiber] of Object.entries(fibers)) {
    await fiber.await();
    if (fiber.state !== 2) throw new Error(`plugin "${name}" failed to activate (state ${fiber.state})`);
}
const buddyFiber = app.plugin(BuddyLoop, { buddyMaxTurns: 3, agents: [] });
await buddyFiber.await();
if (buddyFiber.state !== 2) throw new Error(`buddy-loop failed to activate (state ${buddyFiber.state}): ${buddyFiber._error?.message ?? ''}`);

async function main() {
    console.log('[boot] services mounted');
    console.log('[boot] agentLoop accessor:', typeof app.agentLoop);

    const { agent } = await app.agents.create({
        sessionId: SESSION_ID,
        agentOptions: {},
    });
    console.log('[agent] created:', agent.id, '| status:', agent.status);

    // Observe live stream frames as they dispatch.
    app.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject.id !== SESSION_ID) return;
        if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
            process.stdout.write(frame.chunk.text);
        } else if (frame.type === 'start') {
            process.stdout.write('\n[stream] --- assistant start ---\n');
        } else if (frame.type === 'end') {
            process.stdout.write('\n[stream] --- assistant end ---\n');
        }
    });

    agent.send(
        createUserMessage({
            content: [{ type: 'text', text: '请只回复一句话：换心手术 Stage1 回路验证成功。不要执行任何工具操作。' }],
        }),
        'next-turn',
        true,
    );

    await agent.whenIdle();
    console.log('[agent] idle again, status:', agent.status);

    // Dump the durable session log.
    console.log('\n=== session log ===');
    for (let seq = 0; seq < agent.session.seq; seq++) {
        const event = agent.session.eventAt(seq);
        const summary = JSON.stringify(event.data).slice(0, 220);
        console.log(`${String(event.seq).padStart(4)} ${event.type.padEnd(22)} ${summary}`);
    }

    const events = [];
    for (let seq = 0; seq < agent.session.seq; seq++) {
        events.push(agent.session.eventAt(seq));
    }
    const assistant = events.find((e) => e.type === 'assistant/message');
    if (!assistant) {
        console.error('\n[FAIL] no assistant/message in session log');
        process.exitCode = 1;
        return;
    }
    const text = assistant.data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    const source = assistant.data.message.source;
    console.log('\n=== verification ===');
    console.log('assistant text :', text);
    console.log('source.provider:', source?.provider);
    console.log('source.model   :', source?.model);
    console.log('usage          :', JSON.stringify(assistant.data.usage ?? null));

    const ok = text.includes('Stage1') || text.length > 0;
    const brainOk = source?.provider === 'codebuddy';
    console.log(ok && brainOk ? '\n[PASS] CodeBuddy brain answered inside the dsh session.' : '\n[FAIL] unexpected brain or empty answer');
    if (!(ok && brainOk)) process.exitCode = 1;
}

main().catch((error) => {
    console.error('[fatal]', error);
    process.exitCode = 1;
});
