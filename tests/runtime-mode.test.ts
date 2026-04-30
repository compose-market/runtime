import { describe, expect, it } from "vitest";

import {
  resolveRuntimeHostMode,
  shouldEnforceCloudPermissions,
  shouldInitializeWorkflowRuntime,
} from "../src/manowar/mode.js";

describe("runtime host mode helpers", () => {
  it("defaults to cloud and switches to local when RUNTIME_HOST_MODE=local", () => {
    expect(resolveRuntimeHostMode({ env: {} })).toBe("cloud");
    expect(resolveRuntimeHostMode({
      env: {
        RUNTIME_HOST_MODE: "local",
      },
    })).toBe("local");
  });

  it("disables embedded workflow workers in local-host runtime, in tests, and on the explicit disable flag", () => {
    expect(shouldInitializeWorkflowRuntime({
      env: {
        RUNTIME_DISABLE_TEMPORAL_WORKERS: "true",
      },
    })).toBe(false);

    expect(shouldInitializeWorkflowRuntime({
      env: {
        VITEST: "true",
      },
    })).toBe(false);

    expect(shouldInitializeWorkflowRuntime({
      env: {
        RUNTIME_HOST_MODE: "local",
      },
    })).toBe(false);
  });

  it("keeps workflow workers enabled for cloud runtime hosts", () => {
    expect(shouldInitializeWorkflowRuntime({
      env: {},
    })).toBe(true);
  });

  it("only enforces Backpack cloud permissions when running as a cloud runtime host", () => {
    expect(shouldEnforceCloudPermissions({
      env: {},
    })).toBe(true);

    expect(shouldEnforceCloudPermissions({
      env: {
        RUNTIME_HOST_MODE: "local",
      },
    })).toBe(false);
  });
});
