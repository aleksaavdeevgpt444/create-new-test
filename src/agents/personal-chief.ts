// Stage A16 — Personal Operations AI Chief
import { Env } from '../types';
import { runAgentWithTrace, createHandoff } from './core';

export async function personalDailyCommand(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'personal_operations_ai_chief', 'personal', 'daily_personal_command', async (requestId, traceId) => {
    const agenda = [
      { area: 'Inbox', task: 'Review and triage incoming messages and ideas', agent: 'personal_assistant_agent' },
      { area: 'Projects', task: 'Review active projects status and next steps', agent: 'personal_pm_agent' },
    ];

    const handoffs = [];
    for (const item of agenda) {
      const handoffId = await createHandoff(
        db,
        'personal_operations_ai_chief',
        item.agent as any,
        `Daily personal command: ${item.task}`,
        { context },
        'Summary + task proposals (approval required before creation)'
      );
      handoffs.push({ ...item, handoff_id: handoffId });
    }

    return {
      summary: `Personal daily command issued. ${handoffs.length} agents activated.`,
      result: {
        date: new Date().toISOString().slice(0, 10),
        agenda,
        handoffs,
      },
      proposals: [],
    };
  });
}
