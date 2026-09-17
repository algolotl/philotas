// GET /api/alerts?region=<id> — entities currently matching the active rules,
// plus active detection-workflow runs. Rule alerts and detection alerts share
// one surface: the operator sees one alert list, each row naming what raised it.
import { getRegion } from '@/lib/regions';
import { evaluateAlerts } from '@/lib/rules';
import { workflowAlerts } from '@/lib/workflows';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const ruleAlerts = await evaluateAlerts(region);
  // Workflow runs are region-scoped; failures here must not blank the rule list.
  const wfAlerts = await workflowAlerts(region.id).catch(() => []);
  const alerts = [...wfAlerts, ...ruleAlerts];
  return Response.json({ region: region.id, count: alerts.length, alerts }, { headers: { 'Cache-Control': 'no-store' } });
}
