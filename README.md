# Resilience

A small TypeScript toolkit that wraps any function (sync or async) with the patterns you reach for when something flaky needs to be made boring: **retries**, **timeouts**, **backoff** (fixed or exponential-with-jitter), a **circuit breaker**, and a hook surface for **metrics**.

Published on npm as [`@oldwhisper/resilience`](https://www.npmjs.com/package/@oldwhisper/resilience).

## Install

```bash
npm install @oldwhisper/resilience
```

## Quick start

```ts
import { WrapperInit } from "@oldwhisper/resilience";

function greet(x: number, y: number) {
  return x + y;
}

const metrics = new WrapperInit();
const resilientGreet = metrics.wrap(greet)

const result = resilientGreet(1, 2);
console.log(result);
console.log(metrics.functionCalls, metrics.f_store);
```

## Core API

### withResilience(fn, config)

Wrap any function with retry, timeout, backoff, and circuit breaker support.

```ts
import { withResilience } from "@oldwhisper/resilience";

const resilient = withResilience(fetchData, {
  name: "fetchData",
  retries: 3,
  timeoutMs: 1000,
  backoff: { type: "fixed", delayMs: 100 },
  hooks: {
    onAttempt: ({ name, attempt }) => console.log(name, attempt),
  },
});

await resilient();
```

### WrapperInit

Metrics adapter that exposes hooks and a convenience `wrap()` helper.

```ts
const metrics = new WrapperInit();
const wrapped = metrics.wrap(task, { retries: 1, timeoutMs: 500 });
await wrapped();

console.log(metrics.functionCalls);
console.log(metrics.f_store.get("task"));
```

## Config

```ts
type BackoffStrategy =
  | { type: "fixed"; delayMs: number }
  | { type: "exponential"; baseDelayMs: number; maxDelayMs: number; jitter?: boolean }

type CircuitBreakerConfig = {
  failureThreshold: number
  resetTimeoutMs: number
}

type ResilienceHooks = {
  onAttempt?: (info: { name: string; attempt: number }) => void
  onSuccess?: (info: { name: string; attempt: number; timeMs: number }) => void
  onFailure?: (info: { name: string; attempt: number; timeMs: number; error: unknown }) => void
  onRetry?: (info: { name: string; attempt: number; delayMs: number; error: unknown }) => void
  onCircuitOpen?: (info: { name: string }) => void
  onCircuitHalfOpen?: (info: { name: string }) => void
  onCircuitClosed?: (info: { name: string }) => void
}

type ResilienceConfig = {
  name?: string
  timeoutMs?: number
  retries?: number
  backoff?: BackoffStrategy
  retryOn?: (err: unknown) => boolean
  circuitBreaker?: CircuitBreakerConfig
  hooks?: ResilienceHooks
}
```

## Notes

- `withResilience` returns an async function, even if the original function is sync.
- Metrics are collected via hooks.
- If `useAbortSignal: true`, `sleep()` and `resilientFetch()` will be cancelled automatically on timeout.
