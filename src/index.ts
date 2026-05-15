// Stage A1 — Main Cloudflare Worker Entry Point
// AI Agents System — MVP
import { Env } from './types';
import { handleRequest } from './router';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },

  // Cloudflare Cron Trigger support (for scheduled tasks)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.AGENT_DB) {
      console.warn('[Scheduler] AGENT_DB not configured — skipping scheduled run');
      return;
    }

    const { processDueSchedules } = await import('./scheduler/index');
    const { recordHeartbeat, detectStuckRuns } = await import('./hardening/index');

    try {
      await recordHeartbeat(env.AGENT_DB, 'scheduler', 'alive', 'Cron triggered');
      const { processed, errors } = await processDueSchedules(env.AGENT_DB, env);
      if (errors.length > 0) {
        console.error('[Scheduler] Errors:', errors);
      }
      const stuckCount = await detectStuckRuns(env.AGENT_DB);
      if (stuckCount > 0) {
        console.warn(`[Scheduler] ${stuckCount} stuck runs detected`);
      }
      console.log(`[Scheduler] Processed ${processed} schedules`);
    } catch (err) {
      console.error('[Scheduler] Fatal error:', err);
      await recordHeartbeat(env.AGENT_DB, 'scheduler', 'degraded', err instanceof Error ? err.message : String(err));
    }
  },
};
