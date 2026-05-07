import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_USER_AGENT = "Compose-Market-Connectors/0.1 (+https://compose.market)";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function completeAndExit(res, status, body, exitCode = 0) {
  json(res, status, body);
  if (process.env.MCP_RUNNER_EXIT_AFTER_REQUEST !== "false") {
    shutdownAfterFlush(exitCode);
  }
}

function shutdownAfterFlush(exitCode = 0) {
  setTimeout(() => {
    console.log(`[mcp-runner] shutdown requested; exiting ${exitCode}`);
    process.exit(exitCode);
  }, 50).unref();
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteArg(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isSafePackageName(pkg) {
  return typeof pkg === "string"
    && pkg.length > 0
    && pkg.length <= 214
    && !/[\s;&|`$<>]/.test(pkg);
}

function isSafeArg(arg) {
  return typeof arg === "string" && !/[;&|`$<>]/.test(arg);
}

function detectCredentialVars(text) {
  const out = new Set();
  const patterns = [
    /requires credentials:\s*([A-Z_][A-Z0-9_]{2,})/gi,
    /missing (?:required )?(?:environment variable|env var|credential)[:\s]+([A-Z_][A-Z0-9_]{2,})/gi,
    /([A-Z_][A-Z0-9_]{2,})\s+(?:environment variable|required|is required)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      out.add(match[1].toUpperCase());
    }
  }
  return [...out].filter((name) => !["MCP", "API", "JSON", "ERROR", "SERVER"].includes(name));
}

function normalizeEnvNames(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z][A-Z0-9_]{2,}$/.test(value))
    .filter((value) => !["MCP", "API", "JSON", "ERROR", "SERVER"].includes(value)))].sort();
}

function missingRequiredEnv(config, envProvided) {
  const required = normalizeEnvNames(config?.envRequired);
  if (required.length === 0) return [];
  const merged = {
    ...process.env,
    ...(config?.env || {}),
    ...(envProvided || {}),
  };
  return required.filter((name) => !merged[name]);
}

function splitNodeOptions(value) {
  return String(value || "").split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function mergeNodeOptions(...values) {
  const preload = process.env.COMPOSE_FETCH_PRELOAD || "/app/fetch-defaults.cjs";
  const parts = [];
  if (existsSync(preload)) {
    parts.push(`--require=${preload}`);
  }
  for (const value of values) {
    parts.push(...splitNodeOptions(value));
  }
  return [...new Set(parts)].join(" ");
}

function childEnv(config, envProvided) {
  const merged = {
    ...process.env,
    ...(config?.env || {}),
    ...(envProvided || {}),
  };
  merged.COMPOSE_OUTBOUND_USER_AGENT = merged.COMPOSE_OUTBOUND_USER_AGENT || DEFAULT_USER_AGENT;
  const nodeOptions = mergeNodeOptions(
    process.env.NODE_OPTIONS,
    config?.env?.NODE_OPTIONS,
    envProvided?.NODE_OPTIONS,
  );
  if (nodeOptions) merged.NODE_OPTIONS = nodeOptions;
  return merged;
}

function buildStdioCommand(config) {
  if (config.transport === "npx") {
    if (!isSafePackageName(config.package)) throw new Error(`unsafe npm package: ${config.package}`);
    const args = Array.isArray(config.args) ? config.args : [];
    if (!args.every(isSafeArg)) throw new Error("unsafe npx args");
    return ["npx", "-y", config.package, ...args].map(quoteArg).join(" ");
  }

  if (config.transport === "stdio") {
    const command = config.command;
    if (command !== "uvx" && command !== "npx" && command !== "python" && command !== "node") {
      throw new Error(`stdio command not allowed: ${command}`);
    }
    const args = Array.isArray(config.args) ? config.args : [];
    if (!args.every(isSafeArg)) throw new Error("unsafe stdio args");
    return [command, ...args].map(quoteArg).join(" ");
  }

  if (config.transport === "docker") {
    if (!process.env.ENABLE_DOCKER_TRANSPORT) {
      throw new Error("docker transport requires ENABLE_DOCKER_TRANSPORT and a Docker-capable runner");
    }
    if (!config.image || /[\s;&|`$<>]/.test(config.image)) throw new Error(`unsafe image: ${config.image}`);
    return ["docker", "run", "--rm", "-i", config.image].map(quoteArg).join(" ");
  }

  throw new Error(`unsupported runner transport: ${config.transport}`);
}

function nextPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate runner port"));
      });
    });
  });
}

async function startGateway(config, envProvided, deadlineMs) {
  const port = await nextPort();
  const stdio = buildStdioCommand(config);
  const gatewayBin = process.env.SUPERGATEWAY_BIN || "supergateway";
  const child = spawn(gatewayBin, [
    "--stdio", stdio,
    "--outputTransport", "streamableHttp",
    "--stateful",
    "--sessionTimeout", String(Math.max(deadlineMs, 60_000)),
    "--port", String(port),
    "--streamableHttpPath", "/mcp",
    "--logLevel", process.env.SUPERGATEWAY_LOG_LEVEL || "info",
  ], {
    env: childEnv(config, envProvided),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (process.env.MCP_RUNNER_DEBUG === "true") process.stdout.write(text);
  });

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const startedAt = Date.now();
  let lastError = "";
  const startupBudgetMs = Math.min(deadlineMs, 90_000);
  const probeTimeoutMs = Math.min(10_000, Math.max(3_000, Math.floor(deadlineMs / 4)));
  while (Date.now() - startedAt < startupBudgetMs) {
    if (child.exitCode !== null) {
      throw new Error(stderr || `supergateway exited with code ${child.exitCode}`);
    }
    try {
      const initialized = await rpcRaw(endpoint, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "compose-mcp-runner", version: "1.0.0" },
      }, 0, undefined, probeTimeoutMs);
      const sessionId = initialized.sessionId;
      if (!sessionId) {
        throw new Error("supergateway did not return mcp-session-id");
      }
      await rpcRaw(endpoint, "notifications/initialized", {}, undefined, sessionId, probeTimeoutMs).catch(() => null);
      return {
        endpoint,
        sessionId,
        serverInfo: initialized.result?.serverInfo || initialized.result?.server_info || null,
        child,
        close: () => {
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => {
            try { if (child.exitCode === null) child.kill("SIGKILL"); } catch {}
          }, 1500).unref();
        },
        stderr: () => stderr,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }

  try { child.kill("SIGTERM"); } catch {}
  throw new Error(stderr || lastError || "supergateway did not become ready");
}

async function rpcRaw(endpoint, method, params, id = 1, sessionId, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const body = id === undefined
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", method, params, id };
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }
    return {
      result: parseRpcResponse(text, response.headers.get("content-type") || ""),
      sessionId: response.headers.get("mcp-session-id") || sessionId,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(endpoint, method, params, id = 1, sessionId, timeoutMs = 15000) {
  const response = await rpcRaw(endpoint, method, params, id, sessionId, timeoutMs);
  return response.result;
}

function parseRpcResponse(text, contentType) {
  if (!text) return {};
  if (contentType.includes("text/event-stream")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      last = JSON.parse(data);
    }
    if (!last) return {};
    if (last.error) throw new Error(formatRpcError(last.error));
    return last.result || last;
  }
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(formatRpcError(parsed.error));
  return parsed.result || parsed;
}

function formatRpcError(error) {
  const message = error?.message || "JSON-RPC error";
  const data = error?.data === undefined ? "" : ` ${JSON.stringify(error.data)}`;
  return `${message}${data}`;
}

async function withGateway(input, fn) {
  const deadlineMs = Math.max(5000, Math.min(Number(input.deadlineMs || DEFAULT_DEADLINE_MS), 120_000));
  let gateway;
  try {
    const missing = missingRequiredEnv(input.config || {}, input.envProvided || {});
    if (missing.length > 0) {
      return {
        ok: false,
        code: "CREDENTIALS_REQUIRED",
        message: `credentials required: ${missing.join(", ")}`,
        credentialVars: missing,
        retryable: false,
      };
    }
    gateway = await startGateway(input.config || {}, input.envProvided || {}, deadlineMs);
    return await fn(gateway, deadlineMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const credentialVars = detectCredentialVars(message);
    return {
      ok: false,
      code: credentialVars.length > 0 ? "CREDENTIALS_REQUIRED" : "MCP_SPAWN_FAILED",
      message,
      credentialVars,
      retryable: credentialVars.length === 0,
    };
  } finally {
    if (gateway) gateway.close();
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true, service: "mcp-runner" });
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      json(res, 200, { ok: true, service: "mcp-runner", shuttingDown: true });
      shutdownAfterFlush(0);
      return;
    }
    if (req.method !== "POST" || (req.url !== "/inspect" && req.url !== "/call")) {
      json(res, 404, { ok: false, code: "MCP_CONFIG_NOT_FOUND", message: "route not found" });
      return;
    }

    const input = await readJson(req);
    const result = await withGateway(input, async (gateway, deadlineMs) => {
      if (req.url === "/inspect") {
        const listed = await rpc(gateway.endpoint, "tools/list", {}, 2, gateway.sessionId, deadlineMs);
        return {
          ok: true,
          transportUsed: input.config?.transport || "unknown",
          credentialVars: [],
          serverInfo: gateway.serverInfo || null,
          tools: listed.tools || [],
        };
      }
      const called = await rpc(gateway.endpoint, "tools/call", {
        name: input.toolName,
        arguments: input.args || {},
      }, 3, gateway.sessionId, deadlineMs);
      return {
        ok: true,
        result: called.content?.[0]?.text ? parseMaybeJson(called.content[0].text) : called,
      };
    });
    completeAndExit(res, result.ok ? 200 : (result.code === "CREDENTIALS_REQUIRED" ? 200 : 502), result, 0);
  })().catch((error) => {
    json(res, 500, {
      ok: false,
      code: "MCP_RUNTIME_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
    if (req.url === "/inspect" || req.url === "/call") {
      shutdownAfterFlush(1);
    }
  });
});

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mcp-runner] listening on ${PORT}`);
});
