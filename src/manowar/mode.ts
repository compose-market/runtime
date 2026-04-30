export type RuntimeHostMode = "cloud" | "local";

export function resolveRuntimeHostMode(options?: {
  env?: NodeJS.ProcessEnv;
}): RuntimeHostMode {
  const env = options?.env || process.env;
  const value = String(env.RUNTIME_HOST_MODE || "").trim().toLowerCase();
  return value === "local" ? "local" : "cloud";
}

export function shouldInitializeWorkflowRuntime(options?: {
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options?.env || process.env;

  if (resolveRuntimeHostMode({ env }) === "local") {
    return false;
  }

  if (env.VITEST === "true" || env.NODE_ENV === "test") {
    return false;
  }

  if (env.RUNTIME_DISABLE_TEMPORAL_WORKERS === "true") {
    return false;
  }

  return true;
}

export function shouldEnforceCloudPermissions(options?: {
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveRuntimeHostMode(options) !== "local";
}
