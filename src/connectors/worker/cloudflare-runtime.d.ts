declare module "cloudflare:workers" {
    export interface DurableObjectState {
        storage: unknown;
        container?: unknown;
        blockConcurrencyWhile<T>(callback: () => Promise<T>): void;
    }

    export abstract class DurableObject<Env = unknown> {
        protected ctx: DurableObjectState;
        protected env: Env;
        constructor(ctx: DurableObjectState, env: Env);
    }

    export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
        protected env: Env;
        protected ctx: unknown;
        constructor(ctx: unknown, env: Env);
        abstract run(
            event: Readonly<{
                payload: Readonly<Params>;
                timestamp: Date;
                instanceId: string;
            }>,
            step: {
                do<T>(
                    name: string,
                    config: {
                        retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" };
                        timeout?: string | number;
                    },
                    callback: () => Promise<T>,
                ): Promise<T>;
            },
        ): Promise<unknown>;
    }
}
