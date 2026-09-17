// Shared rate limiter for Transport for NSW.
//
// The Bronze plan's 5 requests/second is enforced per API KEY, not per API, and
// two different feeds use the same key: transport fetches one endpoint per mode
// (five of them) and cameras fetches one. Each is individually well-behaved and
// together they burst past the cap — most visibly on a cold start, when every
// poller fires at once and whichever request loses the race gets a 429.
//
// So the budget has to be shared, which means a single queue rather than
// per-feed politeness. Requests are serialised with a minimum gap; 250ms is
// 4/sec, comfortably under the cap with room for clock skew.
//
// This is deliberately a plain in-process queue. It is exactly right for one
// replica and would need Redis or similar for several — worth knowing before
// this is scaled out.

const MINIMUM_GAP_MS = 250;

let queueTail = Promise.resolve();
let lastDispatchMs = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run `task` on the shared TfNSW queue. Preserves both resolution and
// rejection, so callers keep their own error handling.
export function tfnswRequest(task) {
  const scheduled = queueTail.then(async () => {
    const since = Date.now() - lastDispatchMs;
    if (since < MINIMUM_GAP_MS) await wait(MINIMUM_GAP_MS - since);
    lastDispatchMs = Date.now();
    return task();
  });
  // The tail must not reject, or one failure would poison every queued request
  // behind it.
  queueTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}
