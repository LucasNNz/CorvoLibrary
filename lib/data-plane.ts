import { waitUntil } from '@vercel/functions';
import { runSupervisorWatchdog } from './supervisor-lease';
import { runWorkerWatchdog } from './worker-orchestration';
import { runSupervisorPlansTick } from './supervisor-plan-engine';
import { processSupervisorDecisionJobs } from './fast-supervisor-decisions';
import { processQueuedDownloadPackages } from './delivery-packages';

export async function pumpDataPlane(source: string, maxPasses = 4, maxWallMs = 25_000) {
  const started = Date.now();
  let last: Awaited<ReturnType<typeof runSupervisorPlansTick>> | null = null;
  let fastDecisionNeedsReschedule = false;
  let packageNeedsReschedule = false;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const remaining = Math.max(1_000, maxWallMs - (Date.now() - started));
    const fastDecisions = await processSupervisorDecisionJobs({ maxJobs: 1, maxWallMs: remaining, source: `${source}:FAST_DECISIONS:${pass}` });
    fastDecisionNeedsReschedule = fastDecisions.needs_reschedule;
    const packages = await processQueuedDownloadPackages({ maxJobs: 1 });
    packageNeedsReschedule = packages.needs_reschedule;
    last = await runSupervisorPlansTick({ source: `${source}:PASS_${pass}`, maxPlans: 10, maxSteps: 3 });
    if (!last.dispatch?.needs_reschedule && !fastDecisionNeedsReschedule && !packageNeedsReschedule) break;
    if (Date.now() - started >= maxWallMs) break;
  }
  return { last, fastDecisionNeedsReschedule, packageNeedsReschedule, elapsedMs: Date.now() - started };
}

export function wakeDataPlane(source: string) {
  waitUntil(pumpDataPlane(source).then(() => undefined).catch((error) => {
    console.error('[corvo:data-plane:wake]', source, error);
  }));
}

export async function runDataPlaneRecovery(source = 'MANUAL_RECOVERY') {
  const watchdog = await Promise.all([
    runSupervisorWatchdog({ source }),
    runWorkerWatchdog({ source }),
  ]);
  const pump = await pumpDataPlane(source, 6, 50_000);
  return { watchdog, pump };
}
