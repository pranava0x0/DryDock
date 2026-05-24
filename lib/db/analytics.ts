import { getDb } from "./index";

export interface ProjectStats {
  project_id: string;
  project_name: string;
  total_runs: number;
  success_runs: number;
  failed_runs: number;
  avg_duration_s: number | null;
  p50_duration_s: number | null;
  p90_duration_s: number | null;
  total_cost_usd: number;
}

export interface DailyTick {
  date: string;
  success: number;
  failed: number;
  cost_usd: number;
}

export interface FailureBreakdown {
  gate_failure: number;
  agent_exit_failure: number;
}

export interface AnalyticsSummary {
  total_runs: number;
  success_runs: number;
  failed_runs: number;
  total_cost_usd: number;
  per_project: ProjectStats[];
  daily_trend: DailyTick[];
  failure_breakdown: FailureBreakdown;
}

interface RawRunRow {
  project_id: string;
  project_name: string;
  status: string;
  cost_usd: number | null;
  duration_s: number | null;
  gate_status: string | null;
}

interface DailyRow {
  date: string;
  success: number;
  failed: number;
  cost_usd: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getAnalyticsSummary(): AnalyticsSummary {
  const db = getDb();

  // All runs joined to their project — compute everything in one pass.
  const rawRuns = db
    .prepare(
      `SELECT
         t.project_id,
         p.name AS project_name,
         r.status,
         r.cost_usd,
         CASE WHEN r.completed_at IS NOT NULL
              THEN r.completed_at - r.started_at
              END AS duration_s,
         r.gate_status
       FROM runs r
       JOIN tasks t ON r.task_id = t.id
       JOIN projects p ON t.project_id = p.id`,
    )
    .all() as RawRunRow[];

  // Per-project aggregation in JS so we get percentiles without SQLite extensions.
  const byProject = new Map<
    string,
    {
      name: string;
      total: number;
      success: number;
      failed: number;
      durations: number[];
      cost: number;
    }
  >();
  let totalRuns = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalCost = 0;

  for (const row of rawRuns) {
    totalRuns++;
    if (row.status === "success") totalSuccess++;
    if (row.status === "failed") totalFailed++;
    totalCost += row.cost_usd ?? 0;

    if (!byProject.has(row.project_id)) {
      byProject.set(row.project_id, {
        name: row.project_name,
        total: 0,
        success: 0,
        failed: 0,
        durations: [],
        cost: 0,
      });
    }
    const bucket = byProject.get(row.project_id)!;
    bucket.total++;
    if (row.status === "success") bucket.success++;
    if (row.status === "failed") bucket.failed++;
    if (row.duration_s !== null && row.duration_s >= 0)
      bucket.durations.push(row.duration_s);
    bucket.cost += row.cost_usd ?? 0;
  }

  const per_project: ProjectStats[] = [];
  for (const [project_id, b] of byProject) {
    const sorted = [...b.durations].sort((a, c) => a - c);
    const avg =
      sorted.length > 0
        ? sorted.reduce((s, v) => s + v, 0) / sorted.length
        : null;
    per_project.push({
      project_id,
      project_name: b.name,
      total_runs: b.total,
      success_runs: b.success,
      failed_runs: b.failed,
      avg_duration_s: avg !== null ? Math.round(avg) : null,
      p50_duration_s: percentile(sorted, 50),
      p90_duration_s: percentile(sorted, 90),
      total_cost_usd: b.cost,
    });
  }
  per_project.sort((a, b) => b.total_runs - a.total_runs);

  // 30-day daily trend.
  const dailyRows = db
    .prepare(
      `SELECT
         date(r.started_at, 'unixepoch') AS date,
         SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN r.status = 'failed'  THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(r.cost_usd), 0) AS cost_usd
       FROM runs r
       WHERE r.started_at >= unixepoch('now') - 30 * 86400
       GROUP BY date(r.started_at, 'unixepoch')
       ORDER BY date ASC`,
    )
    .all() as DailyRow[];

  // Failure breakdown — gate fail vs raw agent exit fail.
  const failedRuns = rawRuns.filter((r) => r.status === "failed");
  const gate_failure = failedRuns.filter((r) => r.gate_status === "failed").length;
  const agent_exit_failure = failedRuns.length - gate_failure;

  return {
    total_runs: totalRuns,
    success_runs: totalSuccess,
    failed_runs: totalFailed,
    total_cost_usd: totalCost,
    per_project,
    daily_trend: dailyRows,
    failure_breakdown: { gate_failure, agent_exit_failure },
  };
}
