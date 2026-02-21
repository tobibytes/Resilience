/// <reference path="./global.d.ts" />


/**
 * Active abort signal for the current resilient execution context.
 * Set internally by `withResilience` when `useAbortSignal` is enabled.
 */
let activeSignal: AbortSignal | undefined;

/**
 * Runs a function while temporarily setting the active signal.
 */
async function runWithActiveSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>) {
    const prev = activeSignal;
    activeSignal = signal;
    try {
        return await fn();
    } finally {
        activeSignal = prev;
    }
}



/**
 * Simple circuit breaker implementation.
 */
class CircuitBreaker {
    private state: Resilience.CircuitState = "CLOSED";
    private failures = 0;
    private openedAt = 0;

    constructor(
        private cfg: Resilience.CircuitBreakerConfig,
        private hooks?: Resilience.ResilienceHooks,
        private name = "fn"
    ) { }

    canAttempt(): boolean {
        if (this.state === "CLOSED") return true;

        const now = Date.now();
        if (this.state === "OPEN" && now - this.openedAt >= this.cfg.resetTimeoutMs) {
            this.state = "HALF_OPEN";
            this.hooks?.onCircuitHalfOpen?.({ name: this.name });
            return true;
        }
        return this.state === "HALF_OPEN";
    }

    onSuccess() {
        if (this.state !== "CLOSED") {
            this.state = "CLOSED";
            this.hooks?.onCircuitClosed?.({ name: this.name });
        }
        this.failures = 0;
    }

    onFailure() {
        this.failures += 1;
        if (this.failures >= this.cfg.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
            this.hooks?.onCircuitOpen?.({ name: this.name });
        }
    }
}

/**
 * Computes backoff delay for a given attempt.
 */
function computeBackoffMs(strategy: Resilience.BackoffStrategy | undefined, attempt: number): number {
    if (!strategy) return 0;
    if (strategy.type === "fixed") return strategy.delayMs;

    const raw = strategy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(raw, strategy.maxDelayMs);
    if (!strategy.jitter) return capped;

    return Math.floor(Math.random() * capped);
}

/**
 * Async delay utility.
 */
function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a promise with a timeout and optional abort.
 */
async function withTimeout<T>(
    p: Promise<T>,
    timeoutMs?: number,
    controller?: AbortController
): Promise<T> {
    if (!timeoutMs) return p;
    return await Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(() => {
                controller?.abort();
                reject(new Error("TimeoutError"));
            }, timeoutMs)
        ),
    ]);
}

/**
 * Wraps a function with retries, timeout, backoff, and circuit breaker behavior.
 */
export function withResilience<Fn extends (...args: any[]) => any>(
    fn: Fn,
    config: Resilience.ResilienceConfig = {}
): (...args: Parameters<Fn>) => Promise<Awaited<ReturnType<Fn>>> {
    const name = config.name ?? fn.name ?? "anonymous";
    const retries = config.retries ?? 0;
    const retryOn = config.retryOn ?? (() => true);
    const hooks = config.hooks;

    const breaker = config.circuitBreaker
        ? new CircuitBreaker(config.circuitBreaker, hooks, name)
        : null;

    return (async (...args: Parameters<Fn>): Promise<Awaited<ReturnType<Fn>>> => {
        let lastErr: unknown = undefined;

        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            hooks?.onAttempt?.({ name, attempt });

            if (breaker && !breaker.canAttempt()) {
                const e = new Error(`CircuitOpenError: ${name}`);
                lastErr = e;
                throw e;
            }

            const start = Date.now();
            try {
                const controller = config.useAbortSignal ? new AbortController() : undefined;
                const result = await runWithActiveSignal(controller?.signal, async () => {
                    const execPromise = Promise.resolve(fn(...args)) as Promise<Awaited<ReturnType<Fn>>>;
                    return await withTimeout(execPromise, config.timeoutMs, controller);
                });
                const timeMs = Date.now() - start;

                breaker?.onSuccess();
                hooks?.onSuccess?.({ name, attempt, timeMs });
                return result;
            } catch (err) {
                const timeMs = Date.now() - start;
                lastErr = err;

                breaker?.onFailure();
                hooks?.onFailure?.({ name, attempt, timeMs, error: err });

                const shouldRetry = attempt <= retries && retryOn(err);
                if (!shouldRetry) throw err;

                const waitMs = computeBackoffMs(config.backoff, attempt);
                hooks?.onRetry?.({ name, attempt, delayMs: waitMs, error: err });
                if (waitMs > 0) await delay(waitMs);
            }
        }

        throw lastErr ?? new Error("UnknownError");
    }) as (...args: Parameters<Fn>) => Promise<Awaited<ReturnType<Fn>>>;
}

/**
 * Cancellable sleep. Uses the active signal by default.
 */
export const sleep = (ms: number, signal: AbortSignal | undefined = activeSignal) =>
    new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, ms);
        if (!signal) return;

        if (signal.aborted) {
            clearTimeout(id);
            reject(new Error("Aborted"));
            return;
        }

        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(id);
                reject(new Error("Aborted"));
            },
            { once: true }
        );
    });

/**
 * Fetch wrapper that automatically uses the active abort signal when present.
 */
export const resilientFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? activeSignal;
    if (!signal) return fetch(input, init);
    return fetch(input, { ...init, signal });
};


/**
 * Metrics adapter with helpers for resilience hooks.
 */
export class WrapperInit {
    functionCalls: number = 0
    f_store: Map<string, number> = new Map();

    /**
     * Records a function attempt by name.
     */
    record(name: string) {
        const prev = this.f_store.get(name) ?? 0;
        this.f_store.set(name, prev + 1);
        this.functionCalls++;
    }

    /**
     * Returns resilience hooks that update metrics.
     */
    hooks(): Resilience.ResilienceHooks {
        return {
            onAttempt: ({ name }) => {
                this.record(name);
            },
        };
    }

    /**
     * Wraps a function with resilience behavior and metrics hooks.
     */
    wrap<Fn extends (...args: any[]) => any>(
        fn: Fn,
        config: Omit<Resilience.ResilienceConfig, "hooks" | "name"> & { name?: string } = {}
    ) {
        return withResilience(fn, {
            ...config,
            name: config.name ?? fn.name ?? "anonymous",
            hooks: this.hooks(),
        });
    }

    /**
     * Runs a function and records metrics without resilience features.
     */
    run<Fn extends (...args: any[]) => any>(fn: Fn, ...args: Parameters<Fn>): ReturnType<Fn> {
        const wf = new WrappedFunction(fn, ...args)
        if (!this.f_store.has(wf.name)) {
            this.f_store.set(wf.name, 0)
        }
        const val = wf.run();
        const cur_count: number = this.f_store.get(wf.name) as number;
        this.f_store.set(wf.name, cur_count + 1);
        this.functionCalls++;
        return val.returnValue
    }
}

/**
 * Internal wrapper that records execution metadata.
 */
class WrappedFunction<Fn extends (...args: any[]) => any> implements Resilience.Function {
    fn: Fn;
    args: Parameters<Fn>;
    name: string;

    constructor(fnPtr: Fn, ...args: Parameters<Fn>) {
        this.fn = fnPtr
        this.args = args
        this.name = fnPtr.name
    }

    run(): Resilience.FunctionResult<ReturnType<Fn>> {
        const start = Date.now();
        const r_val = this.fn(...this.args);
        const end = Date.now();
        const dif = end - start;
        const res: Resilience.FunctionResult<ReturnType<Fn>> = {
            time: dif,
            returnValue: r_val,
            inputsCount: this.args.length,
        }
        return res
    }
}
