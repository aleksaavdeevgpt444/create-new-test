// Stage A13 — Personal PM Agent
import { Env } from '../types';
import { runAgentWithTrace, createHandoff, createProposal } from './core';
import { createKnowledgeItem } from '../knowledge/index';

export async function createRoadmap(db: D1Database, env: Env, projectName: string, description: string) {
  return runAgentWithTrace(db, 'personal_pm_agent', 'personal', `create_roadmap:${projectName}`, async (requestId, traceId) => {
    const passport = {
      project_name: projectName,
      description,
      created_at: new Date().toISOString().slice(0, 10),
      status: 'draft',
      contour: 'personal',
    };

    const roadmap = {
      project_name: projectName,
      stages: [
        { stage: 1, name: 'Discovery & Planning', status: 'not_started' },
        { stage: 2, name: 'MVP Implementation', status: 'not_started' },
        { stage: 3, name: 'Testing & Review', status: 'not_started' },
        { stage: 4, name: 'Delivery', status: 'not_started' },
      ],
      note: 'This is a template roadmap. Customize stages as needed.',
    };

    // Save to knowledge base
    await createKnowledgeItem(db, 'personal_pm_agent', 'project_passport', `Passport: ${projectName}`, JSON.stringify(passport), 'local');
    await createKnowledgeItem(db, 'personal_pm_agent', 'roadmap', `Roadmap: ${projectName}`, JSON.stringify(roadmap), 'local');

    // Handoff to Project Builder for execution
    const handoffId = await createHandoff(
      db, 'personal_pm_agent', 'project_builder_agent',
      `Project '${projectName}' roadmap ready for execution`,
      { passport, roadmap },
      'Build execution plan and start stage 1'
    );

    return {
      summary: `Roadmap created for '${projectName}'. Handoff to Project Builder created.`,
      result: { passport, roadmap, handoff_id: handoffId },
      proposals: [],
    };
  });
}

export async function reviewProjectProgress(db: D1Database, env: Env, projectKey?: string) {
  return runAgentWithTrace(db, 'personal_pm_agent', 'personal', 'project_review', async (requestId, traceId) => {
    const builds = await db.prepare('SELECT * FROM agent_project_build_runs ORDER BY created_at DESC LIMIT 10').all();
    return {
      summary: 'Project progress reviewed.',
      result: { builds: builds.results ?? [], project_key: projectKey },
      proposals: [],
    };
  });
}
