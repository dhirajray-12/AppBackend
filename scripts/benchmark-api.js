require("dotenv").config();

const DEFAULT_BASE_URL = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 1004}`;
const BASE_URL = process.env.BENCHMARK_BASE_URL || DEFAULT_BASE_URL;
const ITERATIONS = Math.max(1, Number.parseInt(process.env.BENCHMARK_ITERATIONS || "8", 10));

const scenarios = [
  {
    name: "health",
    path: "/api/health",
    init: { method: "GET" },
  },
  {
    name: "auth.check-role",
    path: "/api/auth/check-role",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dummy.user@example.com" }),
    },
  },
  {
    name: "auth.check-verification-status",
    path: "/api/auth/check-verification-status",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dummy.user@example.com" }),
    },
  },
];

const round = (value) => Number(value.toFixed(2));

async function runScenario({ name, path, init }) {
  const latencies = [];
  let lastStatus = null;
  let lastHeaderLatency = null;

  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(`${BASE_URL}${path}`, init);
    const elapsedMs = performance.now() - startedAt;

    latencies.push(elapsedMs);
    lastStatus = response.status;

    await response.text();
  }

  const total = latencies.reduce((sum, latency) => sum + latency, 0);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = total / latencies.length;

  return {
    name,
    path,
    iterations: ITERATIONS,
    status: lastStatus,
    avgMs: round(avg),
    minMs: round(min),
    maxMs: round(max),
  };
}

async function main() {
  console.log(`Benchmark base URL: ${BASE_URL}`);
  console.log(`Iterations per endpoint: ${ITERATIONS}`);

  for (const scenario of scenarios) {
    try {
      const result = await runScenario(scenario);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({
          name: scenario.name,
          path: scenario.path,
          error: error.message,
        }),
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
