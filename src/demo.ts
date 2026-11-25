import { BudgetGuard } from './guard.js';
import { formatMicroUsd } from './pricing.js';
import { BudgetGuardError } from './types.js';

async function main(): Promise<void> {
  const guard = new BudgetGuard({
    defaultPolicy: {
      budgetUsd: 0.001, // $0.001 daily cap for a small demo
      maxRequestsPerWindow: 5,
      rateWindowMs: 60_000,
      maxConcurrent: 2,
    },
  });

  const tenantId = 'tenant_acme';
  const prompt = 'Summarize this invoice and return JSON with total, currency, and dueDate.';

  console.log('1) Normal request: reserve worst-case, reconcile actual usage');
  const first = await guard.run(
    { tenantId, model: 'gpt-4o-mini', promptText: prompt, maxOutputTokens: 600 },
    async () => ({
      result: '{"total": 420, "currency": "EUR", "dueDate": "2026-12-01"}',
      usage: { inputTokens: 32, outputTokens: 24 },
    }),
  );
  console.log(
    `   reserved=${formatMicroUsd(first.receipt.reservedMicroUsd)} ` +
      `actual=${formatMicroUsd(first.receipt.actualMicroUsd)} ` +
      `remaining=${formatMicroUsd(first.receipt.snapshot.remainingMicroUsd)}`,
  );

  console.log('2) Failed provider call: reservation is automatically released');
  try {
    await guard.run(
      { tenantId, model: 'gpt-4o-mini', promptText: prompt, maxOutputTokens: 600 },
      async () => {
        throw new Error('Upstream 503');
      },
    );
  } catch (error) {
    console.log(`   provider error caught: ${(error as Error).message}`);
  }
  const afterFailure = await guard.getSnapshot(tenantId);
  console.log(
    `   activeReservations=${afterFailure.activeReservations} ` +
      `remaining=${formatMicroUsd(afterFailure.remainingMicroUsd)}`,
  );

  console.log('3) Parallel burst: third concurrent call rejected before touching provider');
  const burst = await Promise.allSettled(
    [1, 2, 3].map((index) =>
      guard.run(
        { tenantId, model: 'gpt-4o-mini', promptText: prompt, maxOutputTokens: 400 },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            result: `ok-${index}`,
            usage: { inputTokens: 30, outputTokens: 40 },
          };
        },
      ),
    ),
  );

  for (const [idx, outcome] of burst.entries()) {
    if (outcome.status === 'fulfilled') {
      console.log(`   call #${idx + 1}: OK (${formatMicroUsd(outcome.value.receipt.actualMicroUsd)})`);
    } else if (outcome.reason instanceof BudgetGuardError) {
      console.log(`   call #${idx + 1}: BLOCKED [${outcome.reason.code}] ${outcome.reason.message}`);
    }
  }

  console.log('4) Oversized call: rejected before provider call because worst-case exceeds remaining budget');
  try {
    await guard.reserve({
      tenantId,
      model: 'gpt-4o',
      promptText: prompt,
      maxOutputTokens: 500,
    });
  } catch (error) {
    if (error instanceof BudgetGuardError) {
      console.log(`   BLOCKED [${error.code}] ${error.message}`);
    }
  }
}

void main();
