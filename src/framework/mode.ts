export type RuntimeHostMode = "cloud" | "local";

export function resolveRuntimeHostMode(options?: {
  env?: NodeJS.ProcessEnv;
}): RuntimeHostMode {
  const env = options?.env || process.env;
  return env.RUNTIME_HOST_MODE === "local" ? "local" : "cloud";
}

export function shouldInitializeWorkflowRuntime(options?: {
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options?.env || process.env;

  if (env.VITEST === "true" || env.NODE_ENV === "test") {
    return false;
  }

  if (env.RUNTIME_DISABLE_TEMPORAL_WORKERS === "true") {
    return false;
  }

  return resolveRuntimeHostMode({ env }) !== "local";
}

export function shouldEnforceCloudPermissions(options?: {
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveRuntimeHostMode(options) === "cloud";
}
