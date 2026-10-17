import type { FastifyInstance } from 'fastify';
import { type Kit, needField } from './kit.js';

const num = (v: unknown) => (v == null ? 0 : Number(v));

function days(qs: Record<string, string>, fallback: number) {
  const n = parseInt(qs.days ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : fallback;
}

// Every query runs under the caller's tenant, so row level security keeps each report to one tenant.
export function reportRoutes(app: FastifyInstance, kit: Kit) {
  const { authed, can } = kit;

  app.get('/v1/reports/support', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'case', 'read');
      const d = days(req.query as Record<string, string>, 30);
      const unit = d <= 31 ? 'day' : 'week';
      const open = `status NOT IN ('solved', 'closed')`;

      const t = (await db.query(
        `WITH w AS (SELECT now() - make_interval(days => $1::int) AS since)
         SELECT
           count(*) FILTER (WHERE opened_at >= since) AS opened,
           count(*) FILTER (WHERE resolved_at >= since) AS solved,
           count(*) FILTER (WHERE ${open}) AS open_now,
           count(*) FILTER (WHERE ${open} AND (resolution_due_at < now() OR (first_response_at IS NULL AND first_response_due_at < now()))) AS past_sla_now,
           count(*) FILTER (WHERE opened_at >= since AND first_response_due_at IS NOT NULL
                              AND (first_response_at IS NOT NULL OR first_response_due_at < now())) AS fr_known,
           count(*) FILTER (WHERE opened_at >= since AND first_response_due_at IS NOT NULL
                              AND first_response_at IS NOT NULL AND first_response_at <= first_response_due_at) AS fr_met,
           count(*) FILTER (WHERE opened_at >= since AND resolution_due_at IS NOT NULL
                              AND (resolved_at IS NOT NULL OR resolution_due_at < now())) AS res_known,
           count(*) FILTER (WHERE opened_at >= since AND resolution_due_at IS NOT NULL
                              AND resolved_at IS NOT NULL AND resolved_at <= resolution_due_at) AS res_met,
           avg(extract(epoch FROM first_response_at - opened_at) / 60) FILTER (WHERE opened_at >= since AND first_response_at IS NOT NULL) AS avg_first_response_minutes,
           avg(extract(epoch FROM resolved_at - opened_at) / 3600) FILTER (WHERE resolved_at >= since) AS avg_resolution_hours
         FROM support_case, w WHERE deleted_at IS NULL`, [d])).rows[0];

      const series = (await db.query(
        `SELECT g::date::text AS bucket,
                (SELECT count(*) FROM support_case c WHERE c.deleted_at IS NULL
                   AND date_trunc('${unit}', c.opened_at AT TIME ZONE 'UTC') = g) AS opened,
                (SELECT count(*) FROM support_case c WHERE c.deleted_at IS NULL
                   AND date_trunc('${unit}', c.resolved_at AT TIME ZONE 'UTC') = g) AS solved
           FROM generate_series(
                  date_trunc('${unit}', (now() - make_interval(days => $1::int)) AT TIME ZONE 'UTC'),
                  date_trunc('${unit}', now() AT TIME ZONE 'UTC'),
                  interval '1 ${unit}') g
          ORDER BY g`, [d])).rows;

      const byPriority = (await db.query(
        `SELECT priority AS label, count(*)::int AS n FROM support_case
          WHERE deleted_at IS NULL AND opened_at >= now() - make_interval(days => $1::int)
          GROUP BY priority ORDER BY array_position(ARRAY['urgent','high','normal','low'], priority)`, [d])).rows;
      const byStatus = (await db.query(
        `SELECT status AS label, count(*)::int AS n FROM support_case
          WHERE deleted_at IS NULL AND ${open}
          GROUP BY status ORDER BY array_position(ARRAY['new','open','pending customer','escalated'], status)`)).rows;
      const byAssignee = (await db.query(
        `SELECT COALESCE(u.display_name, 'Queue: ' || q.name, 'Unassigned') AS label, count(*)::int AS n
           FROM support_case c
           LEFT JOIN app_user u ON u.tenant_id = c.tenant_id AND u.id = c.owner_user_id
           LEFT JOIN queue q ON q.tenant_id = c.tenant_id AND q.id = c.queue_id
          WHERE c.deleted_at IS NULL AND c.${open}
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`)).rows;

      const pct = (met: unknown, known: unknown) => (num(known) ? Math.round((num(met) / num(known)) * 1000) / 10 : null);
      return {
        days: d, unit,
        totals: {
          opened: num(t.opened), solved: num(t.solved), open_now: num(t.open_now), past_sla_now: num(t.past_sla_now),
          first_response_met_pct: pct(t.fr_met, t.fr_known), resolution_met_pct: pct(t.res_met, t.res_known),
          avg_first_response_minutes: t.avg_first_response_minutes == null ? null : Math.round(num(t.avg_first_response_minutes)),
          avg_resolution_hours: t.avg_resolution_hours == null ? null : Math.round(num(t.avg_resolution_hours) * 10) / 10,
        },
        series: series.map((r) => ({ bucket: r.bucket, opened: num(r.opened), solved: num(r.solved) })),
        by_priority: byPriority, by_status: byStatus, open_by_assignee: byAssignee,
      };
    }));

  app.get('/v1/reports/pipeline', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'opportunity', 'read');
      await needField(db, userId, 'opportunity', ['amount', 'probability']);
      const d = days(req.query as Record<string, string>, 90);

      const stages = (await db.query(
        `SELECT s.name AS label, count(o.id)::int AS n,
                COALESCE(sum(o.amount), 0)::float8 AS amount,
                COALESCE(sum(o.amount * o.probability / 100.0), 0)::float8 AS weighted
           FROM pipeline_stage s
           LEFT JOIN opportunity o ON o.tenant_id = s.tenant_id AND o.stage_id = s.id AND o.deleted_at IS NULL
          WHERE s.deleted_at IS NULL AND NOT s.is_closed
          GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order`)).rows;

      const forecast = (await db.query(
        `SELECT to_char(date_trunc('month', close_date), 'YYYY-MM-01') AS month,
                (date_trunc('month', close_date) < date_trunc('month', current_date)) AS past_due,
                count(*)::int AS n, COALESCE(sum(amount), 0)::float8 AS amount,
                COALESCE(sum(amount * probability / 100.0), 0)::float8 AS weighted
           FROM opportunity WHERE deleted_at IS NULL AND NOT is_closed
          GROUP BY 1, 2 ORDER BY 1`)).rows;

      const closed = (await db.query(
        `SELECT count(*) FILTER (WHERE is_won)::int AS won_n,
                COALESCE(sum(amount) FILTER (WHERE is_won), 0)::float8 AS won_amount,
                count(*) FILTER (WHERE NOT is_won)::int AS lost_n,
                COALESCE(sum(amount) FILTER (WHERE NOT is_won), 0)::float8 AS lost_amount
           FROM opportunity
          WHERE deleted_at IS NULL AND is_closed AND close_date >= current_date - $1::int`, [d])).rows[0];

      const open = (await db.query(
        `SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::float8 AS amount,
                COALESCE(sum(amount * probability / 100.0), 0)::float8 AS weighted
           FROM opportunity WHERE deleted_at IS NULL AND NOT is_closed`)).rows[0];

      const owners = (await db.query(
        `SELECT u.display_name AS label, count(*)::int AS n, COALESCE(sum(o.amount), 0)::float8 AS amount,
                COALESCE(sum(o.amount * o.probability / 100.0), 0)::float8 AS weighted
           FROM opportunity o JOIN app_user u ON u.tenant_id = o.tenant_id AND u.id = o.owner_user_id
          WHERE o.deleted_at IS NULL AND NOT o.is_closed
          GROUP BY u.id, u.display_name ORDER BY 3 DESC, 1 LIMIT 15`)).rows;

      // Account names only appear for people who can read accounts.
      const seeAccounts = (await db.query(`SELECT can_do($1::uuid, 'account', 'read') AS ok`, [userId])).rows[0].ok as boolean;
      const top = (await db.query(
        `SELECT o.id, o.name, CASE WHEN $1::boolean THEN a.name END AS account, s.name AS stage,
                o.amount::float8 AS amount, o.close_date::text AS close_date
           FROM opportunity o
           JOIN pipeline_stage s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
           JOIN account a ON a.tenant_id = o.tenant_id AND a.id = o.account_id
          WHERE o.deleted_at IS NULL AND NOT o.is_closed
          ORDER BY o.amount DESC NULLS LAST, o.close_date LIMIT 8`, [seeAccounts])).rows;

      const lost = (await db.query(
        `SELECT COALESCE(loss_reason, 'No reason given') AS label, count(*)::int AS n
           FROM opportunity WHERE deleted_at IS NULL AND is_closed AND NOT is_won AND close_date >= current_date - $1::int
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, [d])).rows;

      const decided = closed.won_n + closed.lost_n;
      return {
        days: d,
        open: { count: open.n, amount: open.amount, weighted: open.weighted },
        closed: {
          won_count: closed.won_n, won_amount: closed.won_amount, lost_count: closed.lost_n, lost_amount: closed.lost_amount,
          win_rate_pct: decided ? Math.round((closed.won_n / decided) * 1000) / 10 : null,
          avg_won_size: closed.won_n ? Math.round(closed.won_amount / closed.won_n) : null,
        },
        open_by_stage: stages, forecast_by_month: forecast, open_by_owner: owners, top_open_deals: top, loss_reasons: lost,
      };
    }));

  app.get('/v1/reports/accounts', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'account', 'read');
      await needField(db, userId, 'account', ['health_score', 'renewal_date']);

      const t = (await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE type = 'customer')::int AS customers,
                round(avg(health_score))::int AS avg_health,
                count(*) FILTER (WHERE health_score IS NULL)::int AS unscored,
                count(*) FILTER (WHERE health_score < 40)::int AS at_risk,
                count(*) FILTER (WHERE health_score >= 40 AND health_score < 70)::int AS watch,
                count(*) FILTER (WHERE health_score >= 70)::int AS healthy
           FROM account WHERE deleted_at IS NULL`)).rows[0];

      const byType = (await db.query(
        `SELECT COALESCE(type, 'unspecified') AS label, count(*)::int AS n FROM account WHERE deleted_at IS NULL
          GROUP BY 1 ORDER BY 2 DESC, 1`)).rows;

      const atRisk = (await db.query(
        `SELECT a.id, a.name, a.health_score, a.renewal_date::text AS renewal_date, u.display_name AS owner
           FROM account a LEFT JOIN app_user u ON u.tenant_id = a.tenant_id AND u.id = a.owner_user_id
          WHERE a.deleted_at IS NULL AND a.health_score < 40
          ORDER BY a.health_score, a.name LIMIT 25`)).rows;

      const renewals = (await db.query(
        `SELECT a.id, a.name, a.renewal_date::text AS renewal_date, a.health_score, u.display_name AS owner,
                (a.renewal_date - current_date)::int AS days_left
           FROM account a LEFT JOIN app_user u ON u.tenant_id = a.tenant_id AND u.id = a.owner_user_id
          WHERE a.deleted_at IS NULL AND a.renewal_date BETWEEN current_date AND current_date + 90
          ORDER BY a.renewal_date, a.name LIMIT 50`)).rows;

      const overdue = (await db.query(
        `SELECT count(*)::int AS n FROM account WHERE deleted_at IS NULL AND type = 'customer' AND renewal_date < current_date`)).rows[0].n;

      return {
        totals: t,
        health: [
          { label: 'At risk (under 40)', n: t.at_risk }, { label: 'Watch (40 to 69)', n: t.watch },
          { label: 'Healthy (70 and up)', n: t.healthy }, { label: 'Not scored', n: t.unscored },
        ],
        by_type: byType, at_risk: atRisk, renewals_next_90_days: renewals, customer_renewals_past_due: overdue,
      };
    }));
}
