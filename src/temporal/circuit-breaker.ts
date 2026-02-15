/**
 * Temporal Circuit Breaker & Resilience
 * 
 * Implements circuit breaker pattern for Temporal integration with auto-fallback.
 * Pattern: C + A = Circuit breaker + Auto-fallback after N failures
 */

interface CircuitBreakerState {
    failures: number;
    lastFailureTime: number;
    state: "closed" | "open" | "half-open";
}

interface CircuitBreakerConfig {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMaxCalls: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,
    resetTimeoutMs: 30000, // 30 seconds
    halfOpenMaxCalls: 3,
};

class TemporalCircuitBreaker {
    private state: CircuitBreakerState;
    private config: CircuitBreakerConfig;
    private name: string;
    private halfOpenCalls: number = 0;

    constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
        this.name = name;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.state = {
            failures: 0,
            lastFailureTime: 0,
            state: "closed",
        };
    }

    async execute<T>(
        temporalFn: () => Promise<T>,
        fallbackFn: () => Promise<T>,
        context?: string
    ): Promise<T> {
        if (this.state.state === "open") {
            if (Date.now() - this.state.lastFailureTime >= this.config.resetTimeoutMs) {
                this.state.state = "half-open";
                this.halfOpenCalls = 0;
                console.log(`[circuit-breaker:${this.name}] Transitioned to half-open (testing Temporal)`);
            } else {
                console.log(`[circuit-breaker:${this.name}] Circuit OPEN - using fallback (${context || "unknown"})`);
                return await fallbackFn();
            }
        }

        if (this.state.state === "half-open" && this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
            console.log(`[circuit-breaker:${this.name}] Half-open limit reached - using fallback`);
            return await fallbackFn();
        }

        if (this.state.state === "half-open") {
            this.halfOpenCalls++;
        }

        try {
            const result = await temporalFn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            const errorName = error instanceof Error ? error.name : 'Unknown';
            
            // CRITICAL: Enhanced logging for Temporal failures
            console.error(`[circuit-breaker:${this.name}] ❌ TEMPORAL FAILED - Falling back to direct execution`);
            console.error(`[circuit-breaker:${this.name}]    Error Type: ${errorName}`);
            console.error(`[circuit-breaker:${this.name}]    Error Message: ${errorMessage}`);
            console.error(`[circuit-breaker:${this.name}]    Context: ${context || "unknown"}`);
            console.error(`[circuit-breaker:${this.name}]    Circuit State: ${this.state.state}`);
            console.error(`[circuit-breaker:${this.name}]    Failure Count: ${this.state.failures}/${this.config.failureThreshold}`);
            console.error(`[circuit-breaker:${this.name}]    Last Failure: ${new Date(this.state.lastFailureTime).toISOString()}`);
            if (errorStack) {
                console.error(`[circuit-breaker:${this.name}]    Stack Trace: ${errorStack.split('\n').slice(0, 3).join('\n')}`);
            }
            
            return await fallbackFn();
        }
    }

    private onSuccess(): void {
        if (this.state.state === "half-open") {
            this.state.state = "closed";
            this.state.failures = 0;
            this.halfOpenCalls = 0;
            console.log(`[circuit-breaker:${this.name}] Circuit closed (Temporal recovered)`);
        }
    }

    private onFailure(): void {
        this.state.failures++;
        this.state.lastFailureTime = Date.now();

        if (this.state.failures >= this.config.failureThreshold) {
            this.state.state = "open";
            console.error(`[circuit-breaker:${this.name}] 🔴 CIRCUIT OPEN after ${this.state.failures} failures`);
            console.error(`[circuit-breaker:${this.name}]    Will use direct execution for next ${this.config.resetTimeoutMs}ms`);
            console.error(`[circuit-breaker:${this.name}]    NO workflows will be tracked in Temporal Cloud until recovery`);
        }
    }

    getState(): CircuitBreakerState {
        return { ...this.state };
    }

    forceOpen(): void {
        this.state.state = "open";
        this.state.lastFailureTime = Date.now();
    }

    forceClose(): void {
        this.state.state = "closed";
        this.state.failures = 0;
        this.halfOpenCalls = 0;
    }
}

// Global circuit breakers for different Temporal operations
export const manowarCircuitBreaker = new TemporalCircuitBreaker("manowar-execution", {
    failureThreshold: 3,
    resetTimeoutMs: 60000,
});

export const agentCircuitBreaker = new TemporalCircuitBreaker("agent-execution", {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
});

export const toolCircuitBreaker = new TemporalCircuitBreaker("tool-execution", {
    failureThreshold: 10,
    resetTimeoutMs: 15000,
});

export { TemporalCircuitBreaker };
export type { CircuitBreakerState, CircuitBreakerConfig };
