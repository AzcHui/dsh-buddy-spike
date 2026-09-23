import { Context } from '@deepseek-ai/cordis';
import InvariantsService from '@deepseek-ai/dsh-invariants';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SessionService from '@deepseek-ai/dsh-session';
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant';
import AgentService from '@deepseek-ai/dsh-agent';
import * as agentInvariant from '@deepseek-ai/dsh-agent/invariant';
import BuddyLoop from 'dsh-buddy-loop';

const app = new Context();
const fibers = {
  invariants: app.plugin(InvariantsService),
  typert: app.plugin(TypertRegistry),
  sessionProjection: app.plugin(SessionProjection),
  session: app.plugin(SessionService),
  sessionInvariant: app.plugin(sessionInvariant),
  agent: app.plugin(AgentService),
  agentInvariant: app.plugin(agentInvariant),
};
for (const [name, fiber] of Object.entries(fibers)) {
  await fiber.await();
  console.log(name, 'state:', fiber.state);
}
const buddy = app.plugin(BuddyLoop, { buddyMaxTurns: 3, agents: [] });
await buddy.await();
console.log('buddy state:', buddy.state, '| error:', buddy._error?.message ?? 'none');
console.log('agentLoop accessor:', typeof app.agentLoop);
process.exit(0);
