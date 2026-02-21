declare namespace App {

    interface Function<Fn extends (...args: any[]) => any = (...args: any[]) => any> {
        fn: Fn
        args: Parameters<Fn>
        name: string
    }

    interface FunctionResult<R = any> {
        time: number,
        returnValue: R,
        inputsCount: number
    }
    export type BackoffStrategy =
    | { type: "fixed"; delayMs: number }
    | { type: "exponential"; baseDelayMs: number; maxDelayMs: number; jitter?: boolean };

export type CircuitBreakerConfig = {
    failureThreshold: number;
    resetTimeoutMs: number;
};

export type ResilienceHooks = {
    onAttempt?: (info: { name: string; attempt: number }) => void;
    onSuccess?: (info: { name: string; attempt: number; timeMs: number }) => void;
    onFailure?: (info: { name: string; attempt: number; timeMs: number; error: unknown }) => void;
    onRetry?: (info: { name: string; attempt: number; delayMs: number; error: unknown }) => void;
    onCircuitOpen?: (info: { name: string }) => void;
    onCircuitHalfOpen?: (info: { name: string }) => void;
    onCircuitClosed?: (info: { name: string }) => void;
};

export type ResilienceConfig = {
    name?: string;
    timeoutMs?: number;
    retries?: number;
    backoff?: BackoffStrategy;
    retryOn?: (err: unknown) => boolean;
    circuitBreaker?: CircuitBreakerConfig;
    hooks?: ResilienceHooks;
    useAbortSignal?: boolean;
};
}