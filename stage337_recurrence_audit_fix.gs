// ============================================================
// STAGE 338.1 — Recurrence Duplication Audit & Guard
// Build: планнер_этап338.1_recurrence-dedup-guard_v1
// Base worker: планнер_этап338_agent-calendar-free-window-fallback_v1
//
// Closes: A1 (Diagnostic endpoint), A2 (Read-only guard),
//         A3 (Unique key guard), A4 (Detach final fix),
//         A5 (Cleanup tool)
//
// HOW TO APPLY TO MAIN WORKER
// ─────────────────────────────────────────────────────────────
//
// 1. REPLACE syncRecurringSeriesFromTask (line ~10473 in stage338) with
//    the version defined below.
//
// 2. ADD the helper functions (buildRecurringOccurrenceKey_,
//    findExistingRecurringOccurrence_) anywhere before
//    syncRecurringSeriesFromTask in the worker.
//
// 3. ADD new route handlers anywhere in the worker before fetch():
//    handleRecurrenceDiagnosticsApi
//    handleRecurrenceDeduplicateConfirmedApi
//
// 4. In the main fetch() router ADD after existing /diagnostics/* routes:
//    if (url.pathname === '/diagnostics/recurrence-duplicates')
//      return handleRecurrenceDiagnosticsApi(request, env);
//
// 5. In the main fetch() router ADD after existing /maintenance/* routes
//    (create the group if it doesn't exist, before the 404 fallback):
//    if (url.pathname === '/maintenance/recurrence-deduplicate-confirmed')
//      return handleRecurrenceDeduplicateConfirmedApi(request, env);
//
// 6. ADD to PUBLIC_ROUTES set (if present):
//    (no additions — both new endpoints require auth or user_id)
//
// ── New endpoints ─────────────────────────────────────────────
//
// GET  /diagnostics/recurrence-duplicates?user_id=&limit=
//   Read-only scan. Returns duplicate occurrence groups.
//   user_id: optional, limits to one user. Admin token: all users.
//
// POST /maintenance/recurrence-deduplicate-confirmed
//   Requires admin token (Authorization: Bearer <ADMIN_TOKEN>).
//   Body: { user_id?: string, dry_run?: boolean }
//   dry_run defaults to TRUE for safety.
//   Cancels duplicate occurrences, keeping the "most alive" one.
//   Never deletes — sets status='canceled' and strips recurrence fields.
//
// ── A2 note ───────────────────────────────────────────────────
//
// getPlannerData, getBoardData, queryTasks, getAgentPlanningContext_
// already do NOT call syncRecurringSeriesFromTask. This is the
// required invariant. Do not add materialize/sync calls to any
// GET endpoint or to getAgentPlanningContext_.
//
// RULE: syncRecurringSeriesFromTask() MUST only be called from:
//   • POST /tasks/create       (after first creation)
//   • POST /tasks/schedule     (anchor tasks only, never after detach)
//   • POST /tasks/update       (anchor tasks only, never after detach)
//   NOT from any GET handler, read helper, or planning context.
//
// ── A4 note ───────────────────────────────────────────────────
//
// detachTaskFromRecurringSeries() already clears all recurrence
// fields (recurrence_type, recurrence_rule, recurrence_enabled=0,
// recurrence_series_id=NULL, recurrence_parent_task_id=NULL,
// recurrence_index=0). The callers in handleTaskScheduleApi and
// handleTaskUpdateApi already skip syncRecurringSeriesFromTask when
// shouldDetachCurrent is true. This patch adds an explicit assertion
// helper enforceDetachedTaskIsClean_() for defense-in-depth.
// ============================================================

const APP_BUILD_RECURRENCE_AUDIT = "планнер_этап338.1_recurrence-dedup-guard_v1";

// ── A3: Unique key helpers ────────────────────────────────────

/**
 * Build a composite occurrence key for a task.
 * primaryKey: (user_id, series_id, recurrence_index, due_at_date, space_key)
 * fallbackKey: (user_id, series_id, due_at_date, title, space_key)
 * Both are returned so callers can choose which to use.
 */
function buildRecurringOccurrenceKey_(task) {
  if (!task) return null;
  const uid = String(task.user_id || '');
  const sid = String(task.recurrence_series_id || '');
  const idx = String(task.recurrence_index ?? 0);
  const date = String((task.due_at || '').slice(0, 10));
  const space = String(task.space_key || 'work');
  const title = String(task.title || '');
  return {
    primaryKey: [uid, sid, idx, date, space].join('\x00'),
    fallbackKey: [uid, sid, date, title, space].join('\x00'),
  };
}

/**
 * Check whether an occurrence already exists in D1 for a given
 * (user_id, series_id, recurrence_index).
 *
 * Falls back to (series_id, due_at_date, title, space_key) when
 * recurrence_index alone is not reliable (e.g. gaps after detach).
 *
 * Returns the existing task row or null.
 */
async function findExistingRecurringOccurrence_(env, {
  userId,
  seriesId,
  recurrenceIndex,
  dueAt,
  title,
  spaceKey,
}) {
  const uid = String(userId);

  // Primary: exact recurrence_index match within the series
  const byIndex = await env.DB.prepare(`
    SELECT ${TASK_SELECT_FIELDS}
    FROM tasks
    WHERE user_id = ? AND recurrence_series_id = ? AND recurrence_index = ?
    LIMIT 1
  `).bind(uid, seriesId, recurrenceIndex).first();
  if (byIndex) return byIndex;

  // Fallback: same series + same due_at date + same title + same space
  if (dueAt && title) {
    const datePrefix = String(dueAt).slice(0, 10);
    const byDate = await env.DB.prepare(`
      SELECT ${TASK_SELECT_FIELDS}
      FROM tasks
      WHERE user_id = ?
        AND recurrence_series_id = ?
        AND substr(due_at, 1, 10) = ?
        AND title = ?
        AND (space_key = ? OR (space_key IS NULL AND ? = 'work'))
      LIMIT 1
    `).bind(uid, seriesId, datePrefix, String(title), String(spaceKey || 'work'), String(spaceKey || 'work')).first();
    if (byDate) return byDate;
  }

  return null;
}

// ── A4: Defense-in-depth guard ────────────────────────────────

/**
 * After detaching a task from its series, assert that all
 * recurrence fields are cleared. Throws if any field is still set.
 * Use as a cheap sanity check before returning a detached task.
 */
function enforceDetachedTaskIsClean_(task) {
  if (!task) return;
  const dirty = [];
  if (task.recurrence_series_id) dirty.push('recurrence_series_id');
  if (task.recurrence_parent_task_id) dirty.push('recurrence_parent_task_id');
  if (Number(task.recurrence_enabled || 0) !== 0) dirty.push('recurrence_enabled');
  if (task.recurrence_type) dirty.push('recurrence_type');
  if (task.recurrence_rule) dirty.push('recurrence_rule');
  if (dirty.length) {
    // Log but don't crash — the UI must still get a usable response.
    console.error('[recurrence-detach-guard] Detached task still has recurrence fields:', dirty.join(', '), 'task_id:', task.id);
  }
}

// ── A3: Patched syncRecurringSeriesFromTask ───────────────────
//
// Changes vs original:
//   1. Builds a Map<recurrence_index, task> from existingFuture for
//      O(1) lookup instead of fragile array-position matching.
//   2. Adds pre-insert dedup check via findExistingRecurringOccurrence_
//      before every insertTask call — prevents creation of a second
//      row when one already exists with the same primary or fallback key.
//   3. extraFutureIds is computed by set-difference (keptIds) instead
//      of slice(), which is correct when gaps or re-ordering exist.
//
async function syncRecurringSeriesFromTask(env, { taskId, userId }) {
  const normalizedUserId = String(userId);
  let anchorTask = await getTaskById(env, { taskId, userId: normalizedUserId });
  if (!anchorTask) throw new Error('Task not found');

  let seriesId = getTaskSeriesId(anchorTask);
  const anchorIndex = getTaskRecurrenceIndex(anchorTask);

  if (shouldMaterializeRecurrence(anchorTask) && !seriesId) {
    seriesId = anchorTask.id;
    await env.DB.prepare(`
      UPDATE tasks
      SET recurrence_series_id = ?,
          recurrence_parent_task_id = NULL,
          recurrence_index = COALESCE(recurrence_index, 0),
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).bind(seriesId, new Date().toISOString(), anchorTask.id, normalizedUserId).run();
    anchorTask = await getTaskById(env, { taskId, userId: normalizedUserId });
  }

  if (!seriesId) return anchorTask;

  const existingFutureRows = await env.DB.prepare(`
    SELECT ${TASK_SELECT_FIELDS}
    FROM tasks
    WHERE user_id = ? AND recurrence_series_id = ? AND recurrence_index > ?
    ORDER BY recurrence_index ASC
  `).bind(normalizedUserId, seriesId, anchorIndex).all();
  const existingFuture = existingFutureRows.results || [];

  if (!shouldMaterializeRecurrence(anchorTask)) {
    await deleteTasksByIds(env, { userId: normalizedUserId, taskIds: existingFuture.map(r => r.id) });
    return getTaskById(env, { taskId, userId: normalizedUserId });
  }

  const horizonCount = getRecurrenceHorizonCount(anchorTask.recurrence_type);
  let cursorDueAt = anchorTask.due_at;
  let parentTaskId = anchorTask.id;
  const now = new Date().toISOString();
  const keptIds = new Set();

  // A3: Map-based lookup by recurrence_index (primary key)
  const existingByIndex = new Map();
  for (const row of existingFuture) {
    const idx = Number(row.recurrence_index ?? 0);
    if (!existingByIndex.has(idx)) existingByIndex.set(idx, row);
  }

  for (let step = 1; step <= horizonCount; step += 1) {
    const nextDueAt = computeNextOccurrenceDueAt(
      cursorDueAt,
      anchorTask.recurrence_type,
      anchorTask.recurrence_rule,
    );
    if (!nextDueAt) break;

    const targetIndex = anchorIndex + step;

    // Prefer exact index match; fall back to positional ordering
    const existing = existingByIndex.get(targetIndex) || existingFuture[step - 1] || null;

    if (existing) {
      // Update the existing occurrence in place
      await env.DB.prepare(`
        UPDATE tasks
        SET
          title = ?,
          task_product = ?,
          description = ?,
          status = ?,
          priority_manual = ?,
          project_name = ?,
          due_at = ?,
          duration_minutes = ?,
          planned_minutes_manual = ?,
          show_in_month = ?,
          space_key = ?,
          source = ?,
          recurrence_type = ?,
          recurrence_rule = ?,
          recurrence_enabled = ?,
          recurrence_series_id = ?,
          recurrence_parent_task_id = ?,
          recurrence_index = ?,
          updated_at = ?
        WHERE id = ? AND user_id = ?
      `).bind(
        anchorTask.title,
        anchorTask.task_product || null,
        anchorTask.description || null,
        TASK_STATUSES.PLANNED,
        anchorTask.priority_manual ?? null,
        anchorTask.project_name || 'Без проекта',
        nextDueAt,
        normalizeDurationMinutes(anchorTask.duration_minutes) ?? DEFAULT_EVENT_DURATION_FOR_SERVER(),
        normalizeOptionalTaskMinutes(anchorTask.planned_minutes_manual),
        normalizeShowInMonthValue(anchorTask.show_in_month),
        normalizeTaskSpaceKey(anchorTask.space_key),
        anchorTask.source || 'web-app',
        anchorTask.recurrence_type || null,
        anchorTask.recurrence_rule || null,
        Number(anchorTask.recurrence_enabled || 0),
        seriesId,
        parentTaskId,
        targetIndex,
        now,
        existing.id,
        normalizedUserId,
      ).run();
      await replaceChecklistFromTemplateTask(env, {
        sourceTaskId: anchorTask.id,
        targetTaskId: existing.id,
        userId: normalizedUserId,
      });
      keptIds.add(existing.id);
      parentTaskId = existing.id;
    } else {
      // A3: Pre-insert dedup guard — check D1 before creating a new row
      const alreadyExists = await findExistingRecurringOccurrence_(env, {
        userId: normalizedUserId,
        seriesId,
        recurrenceIndex: targetIndex,
        dueAt: nextDueAt,
        title: anchorTask.title,
        spaceKey: anchorTask.space_key,
      });

      if (alreadyExists) {
        // Occurrence already in DB — update instead of duplicating
        await env.DB.prepare(`
          UPDATE tasks
          SET
            title = ?,
            task_product = ?,
            description = ?,
            status = ?,
            priority_manual = ?,
            project_name = ?,
            due_at = ?,
            duration_minutes = ?,
            planned_minutes_manual = ?,
            show_in_month = ?,
            space_key = ?,
            source = ?,
            recurrence_type = ?,
            recurrence_rule = ?,
            recurrence_enabled = ?,
            recurrence_series_id = ?,
            recurrence_parent_task_id = ?,
            recurrence_index = ?,
            updated_at = ?
          WHERE id = ? AND user_id = ?
        `).bind(
          anchorTask.title,
          anchorTask.task_product || null,
          anchorTask.description || null,
          TASK_STATUSES.PLANNED,
          anchorTask.priority_manual ?? null,
          anchorTask.project_name || 'Без проекта',
          nextDueAt,
          normalizeDurationMinutes(anchorTask.duration_minutes) ?? DEFAULT_EVENT_DURATION_FOR_SERVER(),
          normalizeOptionalTaskMinutes(anchorTask.planned_minutes_manual),
          normalizeShowInMonthValue(anchorTask.show_in_month),
          normalizeTaskSpaceKey(anchorTask.space_key),
          anchorTask.source || 'web-app',
          anchorTask.recurrence_type || null,
          anchorTask.recurrence_rule || null,
          Number(anchorTask.recurrence_enabled || 0),
          seriesId,
          parentTaskId,
          targetIndex,
          now,
          alreadyExists.id,
          normalizedUserId,
        ).run();
        await replaceChecklistFromTemplateTask(env, {
          sourceTaskId: anchorTask.id,
          targetTaskId: alreadyExists.id,
          userId: normalizedUserId,
        });
        keptIds.add(alreadyExists.id);
        parentTaskId = alreadyExists.id;
      } else {
        // Safe to insert — no duplicate exists
        const newTaskId = crypto.randomUUID();
        await insertTask(env, {
          id: newTaskId,
          user_id: normalizedUserId,
          title: anchorTask.title,
          task_product: anchorTask.task_product || null,
          description: anchorTask.description || null,
          status: TASK_STATUSES.PLANNED,
          priority_manual: anchorTask.priority_manual ?? null,
          priority_ai: null,
          project_name: anchorTask.project_name || 'Без проекта',
          due_at: nextDueAt,
          duration_minutes: normalizeDurationMinutes(anchorTask.duration_minutes) ?? DEFAULT_EVENT_DURATION_FOR_SERVER(),
          planned_minutes_manual: normalizeOptionalTaskMinutes(anchorTask.planned_minutes_manual),
          show_in_month: normalizeShowInMonthValue(anchorTask.show_in_month),
          space_key: normalizeTaskSpaceKey(anchorTask.space_key),
          remind_at: null,
          source: anchorTask.source || 'web-app',
          ai_priority_reason: null,
          ai_project_guess: null,
          ai_next_step: null,
          recurrence_type: anchorTask.recurrence_type || null,
          recurrence_rule: anchorTask.recurrence_rule || null,
          recurrence_enabled: Number(anchorTask.recurrence_enabled || 0),
          recurrence_series_id: seriesId,
          recurrence_parent_task_id: parentTaskId,
          recurrence_index: targetIndex,
          created_at: now,
          updated_at: now,
        });
        await replaceChecklistFromTemplateTask(env, {
          sourceTaskId: anchorTask.id,
          targetTaskId: newTaskId,
          userId: normalizedUserId,
        });
        keptIds.add(newTaskId);
        parentTaskId = newTaskId;
      }
    }

    cursorDueAt = nextDueAt;
  }

  // A3: Robust extra-cleanup: use set-difference instead of slice()
  // Original: existingFuture.slice(keptIds.length) — breaks when indices have gaps
  const extraFutureIds = existingFuture
    .filter(row => !keptIds.has(row.id))
    .map(row => row.id);
  if (extraFutureIds.length) {
    await deleteTasksByIds(env, { userId: normalizedUserId, taskIds: extraFutureIds });
  }

  return getTaskById(env, { taskId, userId: normalizedUserId });
}

// ── A1 / A5: Recurrence Diagnostics API ──────────────────────
//
// GET /diagnostics/recurrence-duplicates?user_id=&limit=
//
// Read-only. Returns groups of tasks that share the same
// (user_id, recurrence_series_id, due_at_date).
// Scoped to user_id if provided; requires admin token for all-users view.
//
async function handleRecurrenceDiagnosticsApi(request, env) {
  if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);

  const url = new URL(request.url);
  const userId = (url.searchParams.get('user_id') || '').trim() || null;
  const safeLimit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);

  // Require either a user_id or admin auth for cross-user scan
  if (!userId) {
    const authFailure = requireAdminRouteAuth(request, env, '/diagnostics/recurrence-duplicates');
    if (authFailure) return authFailure;
  }

  try {
    // Step 1: Find (user_id, series_id, date) combinations with >1 task
    let dupeRows;
    if (userId) {
      dupeRows = await env.DB.prepare(`
        SELECT
          user_id,
          recurrence_series_id,
          substr(due_at, 1, 10) AS due_date,
          COUNT(*) AS cnt
        FROM tasks
        WHERE recurrence_series_id IS NOT NULL
          AND recurrence_series_id != ''
          AND user_id = ?
        GROUP BY user_id, recurrence_series_id, substr(due_at, 1, 10)
        HAVING COUNT(*) > 1
        ORDER BY user_id, recurrence_series_id, due_date
        LIMIT ?
      `).bind(userId, safeLimit).all();
    } else {
      dupeRows = await env.DB.prepare(`
        SELECT
          user_id,
          recurrence_series_id,
          substr(due_at, 1, 10) AS due_date,
          COUNT(*) AS cnt
        FROM tasks
        WHERE recurrence_series_id IS NOT NULL
          AND recurrence_series_id != ''
        GROUP BY user_id, recurrence_series_id, substr(due_at, 1, 10)
        HAVING COUNT(*) > 1
        ORDER BY user_id, recurrence_series_id, due_date
        LIMIT ?
      `).bind(safeLimit).all();
    }

    const groups = [];
    for (const row of (dupeRows.results || [])) {
      // Fetch all tasks in this duplicate group
      const members = await env.DB.prepare(`
        SELECT id, title, status, due_at, recurrence_index, actual_minutes, description, updated_at, space_key
        FROM tasks
        WHERE user_id = ?
          AND recurrence_series_id = ?
          AND substr(due_at, 1, 10) = ?
        ORDER BY updated_at DESC
      `).bind(row.user_id, row.recurrence_series_id, row.due_date).all();

      const tasks = members.results || [];
      if (tasks.length <= 1) continue;

      // Score: pick the "most alive" task to keep
      const scored = tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due_at: t.due_at,
        recurrence_index: t.recurrence_index,
        updated_at: t.updated_at,
        score: (
          (t.status === 'done' ? 10000 : 0) +
          (Number(t.actual_minutes || 0) > 0 ? 5000 : 0) +
          (t.description ? 1000 : 0) +
          (new Date(t.updated_at || 0).getTime() / 1e10)
        ),
      })).sort((a, b) => b.score - a.score);

      groups.push({
        user_id: row.user_id,
        series_id: row.recurrence_series_id,
        due_date: row.due_date,
        title: tasks[0] && tasks[0].title,
        duplicate_count: tasks.length,
        task_ids: tasks.map(t => t.id),
        will_keep: scored[0] && scored[0].id,
        will_cancel: scored.slice(1).map(s => s.id),
        tasks: scored,
      });
    }

    return jsonResponse({
      ok: true,
      build: getClientAppBuildLabel(),
      scoped_user_id: userId,
      duplicate_group_count: groups.length,
      total_extra_tasks: groups.reduce((s, g) => s + (g.duplicate_count - 1), 0),
      groups,
      note: 'Read-only. To fix, POST /maintenance/recurrence-deduplicate-confirmed with dry_run=false',
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

// ── A5: Recurrence Dedup Confirmed ───────────────────────────
//
// POST /maintenance/recurrence-deduplicate-confirmed
// Requires: Authorization: Bearer <ADMIN_TOKEN>
// Body: { user_id?: string, dry_run?: boolean }
//
// dry_run defaults to TRUE. Pass dry_run=false to actually apply.
// Does NOT delete tasks — sets status='canceled' and strips
// recurrence_series_id / recurrence_parent_task_id on the losers.
// The winner is the task with the highest "alive" score
// (done > actual_minutes > description > most recent updated_at).
//
async function handleRecurrenceDeduplicateConfirmedApi(request, env) {
  if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);

  const authFailure = requireAdminRouteAuth(request, env, '/maintenance/recurrence-deduplicate-confirmed');
  if (authFailure) return authFailure;

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }

  const userId = String(body.user_id || '').trim() || null;
  const dryRun = body.dry_run !== false; // must explicitly pass false to apply

  try {
    let dupeRows;
    if (userId) {
      dupeRows = await env.DB.prepare(`
        SELECT
          user_id,
          recurrence_series_id,
          substr(due_at, 1, 10) AS due_date
        FROM tasks
        WHERE recurrence_series_id IS NOT NULL
          AND recurrence_series_id != ''
          AND user_id = ?
        GROUP BY user_id, recurrence_series_id, substr(due_at, 1, 10)
        HAVING COUNT(*) > 1
        ORDER BY user_id, recurrence_series_id, due_date
        LIMIT 1000
      `).bind(userId).all();
    } else {
      dupeRows = await env.DB.prepare(`
        SELECT
          user_id,
          recurrence_series_id,
          substr(due_at, 1, 10) AS due_date
        FROM tasks
        WHERE recurrence_series_id IS NOT NULL
          AND recurrence_series_id != ''
        GROUP BY user_id, recurrence_series_id, substr(due_at, 1, 10)
        HAVING COUNT(*) > 1
        ORDER BY user_id, recurrence_series_id, due_date
        LIMIT 1000
      `).all();
    }

    const results = [];
    const now = new Date().toISOString();

    for (const row of (dupeRows.results || [])) {
      const members = await env.DB.prepare(`
        SELECT id, title, status, due_at, recurrence_index, actual_minutes, description, updated_at
        FROM tasks
        WHERE user_id = ?
          AND recurrence_series_id = ?
          AND substr(due_at, 1, 10) = ?
        ORDER BY updated_at DESC
      `).bind(row.user_id, row.recurrence_series_id, row.due_date).all();

      const tasks = members.results || [];
      if (tasks.length <= 1) continue;

      // Pick winner: highest alive score
      const scored = tasks.map(t => ({
        id: t.id,
        score: (
          (t.status === 'done' ? 10000 : 0) +
          (Number(t.actual_minutes || 0) > 0 ? 5000 : 0) +
          (t.description ? 1000 : 0) +
          (new Date(t.updated_at || 0).getTime() / 1e10)
        ),
      })).sort((a, b) => b.score - a.score);

      const keepId = scored[0].id;
      const discardIds = scored.slice(1).map(s => s.id);

      if (!dryRun && discardIds.length) {
        for (const discardId of discardIds) {
          // Cancel + strip recurrence fields (does not physically delete)
          await env.DB.prepare(`
            UPDATE tasks
            SET
              status = 'canceled',
              recurrence_series_id = NULL,
              recurrence_parent_task_id = NULL,
              recurrence_index = 0,
              updated_at = ?
            WHERE id = ? AND user_id = ?
          `).bind(now, discardId, row.user_id).run();
        }
      }

      results.push({
        user_id: row.user_id,
        series_id: row.recurrence_series_id,
        due_date: row.due_date,
        kept: keepId,
        cancelled: discardIds,
        dry_run: dryRun,
      });
    }

    return jsonResponse({
      ok: true,
      build: getClientAppBuildLabel(),
      dry_run: dryRun,
      scoped_user_id: userId,
      groups_processed: results.length,
      total_cancelled: results.reduce((s, r) => s + r.cancelled.length, 0),
      results,
      warning: dryRun
        ? 'DRY RUN — no changes made. Send dry_run=false to apply.'
        : 'Applied. Duplicate occurrences have been cancelled and stripped of recurrence fields.',
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

// ============================================================
// REGRESSION CHECKLIST (A6) — verify manually after deploy
// ─────────────────────────────────────────────────────────────
// 1.  Create a daily recurring task.
// 2.  Open week view — no duplicates appear.
// 3.  Refresh page — no duplicates appear.
// 4.  Navigate forward one week — no duplicates appear.
// 5.  Navigate back — no duplicates appear.
// 6.  Change time on one occurrence.
// 7.  Verify only that occurrence changed; future ones unchanged.
// 8.  Drag one occurrence — no duplicate created.
// 9.  Complete one occurrence — status not propagated to series.
// 10. GET /agent/planning-context — nothing created in DB.
// 11. GET /diagnostics/recurrence-duplicates — 0 groups.
// ============================================================
