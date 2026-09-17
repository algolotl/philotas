// scripts/seed-demo.mjs — populate the detection example shown on the site.
//
// What it does, in order:
//   1. clears previously seeded demo rows (detections with source 'demo' and
//      workflow runs tagged demo:true),
//   2. stores real object-detection output — ultralytics yolo11n run over three
//      public photos (a traffic-light intersection and two traffic jams) — as
//      detection rows flagged demo:true, at placeholder coordinates near Sydney
//      so the example plots on the default map view,
//   3. ensures the George St / Park St traffic-light workflow exists,
//   4. runs the REAL workflow engine over the rows, so the alerts you see are
//      genuine engine firings (the built-in Traffic light accident watch fires
//      too), and tags the fired runs demo:true.
//
// Run with:  npm run demo:seed
//
// The seeded alert rows decay after 30 minutes — that is the engine's own alert
// window, not a seed artifact — so re-run this script to refresh the example.

import crypto from 'node:crypto';
import {
  addDetections, addWorkflow, listWorkflows, clearDemoData, updateWorkflowRun,
} from '../lib/db.js';
import { runWorkflowPass } from '../lib/workflows.js';

const REGION = 'sydney';

const DEMO_WORKFLOW = {
  id: 'demo-traffic-light-accident',
  name: 'Traffic light accident watch — George St / Park St',
  enabled: true,
  created_ms: Date.now(),
  region: REGION,
  trigger: {
    classes: ['person', 'bicycle', 'motorcycle', 'car'],
    minScore: 0.4,
    withinMs: 5 * 60_000,
    minDetections: 2,
  },
  actions: [{ type: 'alert', priority: 'high' }],
  cooldownMs: 10 * 60_000,
};

// Real model output, captured from the live service on 2026-08-20:
const CAPTURED_ROWS = [{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.6916,"bbox":[0.4955,0.6832,0.5879,0.7435]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"truck","score":0.6146,"bbox":[0.8579,0.6282,0.9996,0.86]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.5686,"bbox":[0.396,0.6931,0.4325,0.7362]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.3666,"bbox":[0.7366,0.6626,0.824,0.7281]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.3312,"bbox":[0.7382,0.662,0.7965,0.727]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"truck","score":0.3135,"bbox":[0.0866,0.6094,0.1934,0.736]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.2954,"bbox":[0.3219,0.688,0.38,0.7261]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.2735,"bbox":[0.4513,0.6899,0.4778,0.7195]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.2647,"bbox":[0.4948,0.6824,0.5401,0.7415]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.2576,"bbox":[0.4559,0.6933,0.4763,0.7213]},{"sourceId":"demo: Traffic light at South Monroe and Palmer","coord":[151.2092,-33.8656],"class":"car","score":0.2507,"bbox":[0.3474,0.6939,0.3817,0.7248]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.7284,"bbox":[0.7193,0.8001,0.835,0.9994]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.7069,"bbox":[0.293,0.7376,0.5092,0.995]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.6828,"bbox":[0.8691,0.8192,0.9996,0.9815]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.6401,"bbox":[0.8887,0.6491,0.9995,0.8479]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.6297,"bbox":[0.0639,0.8943,0.1641,0.9996]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"bus","score":0.6293,"bbox":[0.1034,0.2264,0.3049,0.4783]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5734,"bbox":[0.3259,0.6833,0.536,0.841]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.552,"bbox":[0.3114,0.6007,0.396,0.7526]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5519,"bbox":[0.4193,0.597,0.5958,0.7792]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5481,"bbox":[0.6136,0.5276,0.7687,0.6804]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.5315,"bbox":[0.0567,0.6949,0.149,0.9076]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5229,"bbox":[0.6359,0.6088,0.8085,0.7028]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5048,"bbox":[0.7985,0.4871,0.9752,0.6516]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.5013,"bbox":[0.8326,0.9634,0.9975,0.9996]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4953,"bbox":[0.4324,0.4704,0.5764,0.5972]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4856,"bbox":[0.934,0.7466,0.9996,0.8283]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4842,"bbox":[0.0602,0.6637,0.2605,0.8704]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4681,"bbox":[0.5681,0.4788,0.7155,0.6474]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4673,"bbox":[0.8287,0.6279,0.9938,0.7538]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"bus","score":0.4553,"bbox":[0.0969,0.2163,0.4175,0.4984]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.4479,"bbox":[0.0567,0.5465,0.142,0.7296]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"bus","score":0.4422,"bbox":[0.5891,0.0545,0.7127,0.1683]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"bus","score":0.4383,"bbox":[0.3947,0.1694,0.5073,0.3731]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"bus","score":0.4335,"bbox":[0.4692,0.0549,0.5977,0.1857]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.4156,"bbox":[0.5234,0.754,0.6156,0.8557]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.4046,"bbox":[0.5829,0.673,0.7735,0.9333]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.3727,"bbox":[0.5241,0.7544,0.6458,0.998]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.3689,"bbox":[0.4076,0.8415,0.6459,0.9995]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.3251,"bbox":[0.2957,0.3957,0.3543,0.5064]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.3186,"bbox":[0.8155,0.2908,0.9156,0.3983]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.2807,"bbox":[0.4454,0.3615,0.5895,0.4616]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.2788,"bbox":[0.225,0.5078,0.4611,0.6844]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"car","score":0.2699,"bbox":[0.9692,0.3786,0.9998,0.5333]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.2671,"bbox":[0.1475,0.7546,0.2232,0.8902]},{"sourceId":"demo: Traffic jam, Delhi (demo image)","coord":[151.215,-33.86],"class":"person","score":0.2573,"bbox":[0.1462,0.754,0.2249,0.9741]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.8758,"bbox":[0.6096,0.4311,0.7624,0.5645]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.8655,"bbox":[0.7105,0.4213,0.9056,0.594]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.7962,"bbox":[0.4813,0.4043,0.6493,0.5347]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"person","score":0.7737,"bbox":[0.3725,0.3929,0.536,0.6923]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.6486,"bbox":[0.8112,0.4628,0.8971,0.6149]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.5461,"bbox":[0.2382,0.3835,0.4104,0.4873]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.5178,"bbox":[0.3767,0.4155,0.4591,0.4986]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.5163,"bbox":[0.2929,0.3841,0.4112,0.4874]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"horse","score":0.5087,"bbox":[0.3753,0.5572,0.5149,0.8593]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.4556,"bbox":[0.6965,0.2496,0.9995,0.9991]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.3048,"bbox":[0.1083,0.3708,0.2491,0.4559]},{"sourceId":"demo: Traffic jam, Nairobi (demo image)","coord":[151.21,-33.87],"class":"car","score":0.2743,"bbox":[0.2364,0.3868,0.3034,0.4817]}];

const now = Date.now();
const rows = CAPTURED_ROWS.map((r) => ({
  ...r,
  id: crypto.randomUUID(),
  region: REGION,
  source: 'demo',
  demo: true,
  detected_at_ms: now,
}));

await clearDemoData();
await addDetections(rows);

const stored = await listWorkflows();
if (!stored.some((w) => w.name === DEMO_WORKFLOW.name)) await addWorkflow(DEMO_WORKFLOW);

const fired = await runWorkflowPass(REGION, rows);
for (const { run } of fired) {
  await updateWorkflowRun(run.id, { ...run.detail, demo: true });
}

console.log('seeded ' + rows.length + ' demo detections; workflows fired: ' + fired.length);
for (const { workflow, run } of fired) console.log('  - ' + workflow.name + ' -> ' + run.detail.label);
console.log('The VISION panel, detection markers and the ALERTS panel now show the example.');
