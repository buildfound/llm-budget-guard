# llm-budget-guard

Small, zero-dependency TypeScript starter for per-tenant LLM spend caps, sliding-window rate limits, and concurrency guards.

It uses a two-phase **reserve -> reconcile / release** flow so parallel requests cannot slip past a budget check before the first completion returns.

## Why two-phase reservations

Checking `spent < limit` before a model call and adding cost afterward fails under concurrency. Ten parallel requests can read the same balance, pass the check, and spend 10x the cap before any single response finishes.

This starter splits each model call into two phases:

1. **Reserve**: estimate worst-case cost from input tokens plus `maxOutputTokens`, verify the tenant's budget, sliding-window RPM, and concurrency cap, and hold a TTL-backed reservation.
2. **Reconcile or release**: replace the reservation with actual provider token usage when the call finishes, or release it if the call throws (with optional partial usage for cancelled streams).

All accounting uses integer microdollars (`1 USD = 1,000,000 microUsd`) to avoid floating-point drift.

## Quick start

Requires Node 20.12 or newer.

```sh
git clone https://github.com/buildfound/llm-budget-guard.git
cd llm-budget-guard
npm install
npm run demo
```

## Usage

### High-level wrapper (`guard.run`)

```ts
import { BudgetGuard, toBudgetErrorResponse } from './src/index.js';

const guard = new BudgetGuard({
  defaultPolicy: {
    budgetUsd: 5.0,
    budgetWindowMs: 24 * 60 * 60 * 1000,
    maxRequestsPerWindow: 60,
    rateWindowMs: 60 * 1000,
    maxConcurrent: 3,
  },
});

export async function POST(req: Request): Promise<Response> {
  const { tenantId, prompt } = (await req.json()) as {
    tenantId: string;
    prompt: string;
  };

  try {
    const { result, receipt } = await guard.run(
      {
        tenantId,
        model: 'gpt-4o-mini',
        promptText: prompt,
        maxOutputTokens: 600,
      },
      async () => {
        // Call your OpenAI, Anthropic, or Gemini client here.
        return {
          result: { answer: '...' },
          usage: { inputTokens: 120, outputTokens: 85 },
        };
      },
    );

    return Response.json({ data: result, spendMicroUsd: receipt.actualMicroUsd });
  } catch (error) {
    const guardResponse = toBudgetErrorResponse(error);
    if (guardResponse) return guardResponse;
    throw error;
  }
}
```

### Streaming calls (`reserve` + `reconcile` / `release`)

For streaming responses where usage arrives on the final chunk, call `reserve()` before opening the upstream stream, `reconcile()` when usage arrives, and `release(reservation, partialUsage)` if the client disconnects early.

## Storage backends

- `MemoryBudgetStore`: default in-memory store for single-process apps and tests.
- `JsonFileBudgetStore`: serialized single-node JSON file store with atomic temp-file renames so spend survives restarts.
- Custom stores: implement the 4-method `BudgetStore` interface (`reserve`, `reconcile`, `release`, `getSnapshot`). For multi-instance deployments, back `reserve` with an atomic Redis Lua script or a Postgres row lock (`SELECT ... FOR UPDATE`).

## Development and CI

```sh
npm run typecheck
npm test
npm run build
node dist/demo.js
```

`.github/workflows/ci.yml` runs `npm ci`, typecheck, tests, build, and the compiled demo on pushes and pull requests with no API keys required.

## Limits

- `estimatePromptTokens` uses a conservative UTF-8 byte heuristic (`bytes / 3.5 + 12`), not a model-specific BPE tokenizer. Pass `estimatedInputTokens` if you already count tokens.
- Reference prices in `DEFAULT_PRICING` are examples; pass your provider's current contract rates via `pricing`.
- Failed calls release their budget reservation and concurrency slot, while keeping the request timestamp in the rate-limit window so broken retry loops still hit RPM caps.
- `MemoryBudgetStore` and `JsonFileBudgetStore` are single-process stores. Use a shared database or Redis backend across multiple server replicas.

Built by [BuildFound](https://buildfound.com), a founder-led AI product studio.

## License

[MIT](LICENSE), copyright 2026 BuildFound.
