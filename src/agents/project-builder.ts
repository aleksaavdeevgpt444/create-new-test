// Stage A21 — Project Builder Agent v1
import { Env, generateId, now } from '../types';
import { runAgentWithTrace } from './core';

export async function runProjectBuild(db: D1Database, env: Env, projectName: string, passport: unknown, roadmap: unknown) {
  return runAgentWithTrace(db, 'project_builder_agent', 'personal', `build:${projectName}`, async (requestId, traceId) => {
    // Create build run
    const runId = generateId();
    await db.prepare('INSERT INTO agent_project_build_runs (id, project_name, passport, roadmap, status, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(runId, projectName, JSON.stringify(passport), JSON.stringify(roadmap), 'running', 'stage_1', now(), now()).run();

    // Validate roadmap
    const roadmapObj = roadmap as Record<string, unknown>;
    const stages = Array.isArray(roadmapObj?.stages) ? roadmapObj.stages : [];
    const check: { passed: boolean; message: string } = stages.length > 0
      ? { passed: true, message: `${stages.length} stages found` }
      : { passed: false, message: 'No stages defined in roadmap' };

    await db.prepare('INSERT INTO agent_project_build_checks (id, run_id, check_name, passed, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(generateId(), runId, 'roadmap_validation', check.passed ? 1 : 0, check.message, now()).run();

    // Generate artifacts
    const artifacts = [
      { type: 'passport', name: 'project_passport.json', content: JSON.stringify(passport, null, 2) },
      { type: 'roadmap', name: 'project_roadmap.json', content: JSON.stringify(roadmap, null, 2) },
      { type: 'execution_plan', name: 'execution_plan.json', content: JSON.stringify({ stages, generated_at: now() }, null, 2) },
    ];

    for (const artifact of artifacts) {
      await db.prepare('INSERT INTO agent_project_build_artifacts (id, run_id, artifact_type, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(generateId(), runId, artifact.type, artifact.name, artifact.content, now()).run();
    }

    // Create delivery package
    const deliveryId = generateId();
    const deliveryPackage = {
      run_id: runId,
      project_name: projectName,
      artifacts: artifacts.map(a => a.name),
      status: 'ready',
      created_at: now(),
      note: 'Deploy/production changes require owner approval — not auto-executed',
    };

    await db.prepare('INSERT INTO agent_project_build_deliveries (id, run_id, delivery_type, package, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(deliveryId, runId, 'full', JSON.stringify(deliveryPackage), 'ready', now()).run();

    await db.prepare("UPDATE agent_project_build_runs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), runId).run();

    return {
      summary: `Project build '${projectName}' completed. ${artifacts.length} artifacts generated. Delivery package ready.`,
      result: { run_id: runId, delivery_id: deliveryId, artifacts: artifacts.map(a => a.name), checks: [check] },
      proposals: [],
    };
  });
}

export async function getBuildRuns(db: D1Database) {
  const r = await db.prepare('SELECT * FROM agent_project_build_runs ORDER BY created_at DESC LIMIT 20').all();
  return r.results ?? [];
}

export async function getBuildArtifacts(db: D1Database, runId: string) {
  const r = await db.prepare('SELECT * FROM agent_project_build_artifacts WHERE run_id = ? ORDER BY created_at').bind(runId).all();
  return r.results ?? [];
}
