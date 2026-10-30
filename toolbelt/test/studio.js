#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const CLI = process.env.STUDIO_CLI_PATH || path.join(os.homedir(), ".pi", "agent", "harness", "toolbelt", "generated", "studio", "studio");
const URL_ENV = "STUDIO_API_URL";
const CREDENTIAL_ENV = "STUDIO_API_KEY";

// The adapter is exercised against a loopback fixture server only. A
// non-loopback URL would turn this regression into a live, paid run, so it
// fails closed instead.
function assertLoopbackUrl(raw) {
  if (!raw) throw new Error(`refusing to run without a loopback ${URL_ENV}`);
  const url = new URL(String(raw));
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`refusing non-loopback ${URL_ENV}: ${url.origin}`);
  }
}

async function run(operation, args, env) {
  assertLoopbackUrl({ ...process.env, ...env }[URL_ENV]);
  const { stdout } = await execFileAsync(CLI, [operation, "--args", JSON.stringify(args || {})], {
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}

async function main() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorizationPresent: request.headers.authorization === "Bearer fixture-value",
        idempotencyKey: request.headers["idempotency-key"] || null,
        body: body ? JSON.parse(body) : null,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v1/intelligence/runs?limit=100") {
        response.end(JSON.stringify({ data: [
          { status: "completed", providerCostEstimate: 0.2, providerCostActual: 0.15 },
          { status: "partial", providerCostEstimate: 0.3, providerCostActual: 0.25 },
        ] }));
        return;
      }
      response.end(JSON.stringify({ data: { id: "run-1", status: "pending_provider_setup" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const env = {
    [URL_ENV]: `http://127.0.0.1:${address.port}`,
    [CREDENTIAL_ENV]: "fixture-value", // secretValuesAccepted: false
  };

  try {
    const started = await run("intelligence-start", {
      websiteUrl: "https://example.com",
      idempotencyKey: "fixture-run-1",
    }, env);
    assert.equal(started.ok, true);
    assert.equal(started.data.id, "run-1");
    assert.deepEqual(requests[0], {
      method: "POST",
      url: "/api/v1/intelligence/runs",
      authorizationPresent: true,
      idempotencyKey: "fixture-run-1",
      body: { websiteUrl: "https://example.com" },
    });

    const summary = await run("cost-summary", {}, env);
    assert.deepEqual(summary.data, {
      runCount: 2,
      byStatus: { completed: 1, partial: 1 },
      providerCostEstimate: 0.5,
      providerCostActual: 0.4,
      currency: "USD",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("studio toolbelt adapter ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
