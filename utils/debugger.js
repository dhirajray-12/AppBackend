// backend/utils/debugger.js - Debug helper to trace execution
const fs = require("fs");
const path = require("path");

class debuggerUtil {
  constructor() {
    this.enabled =
      process.env.NODE_ENV !== "production" || process.env.DEBUG === "true";
    this.traceFile = path.join(__dirname, "../logs/debug-trace.log");
    this.traces = [];
  }

  // Log a debug message with stack trace
  log(message, data = null) {
    if (!this.enabled) return;

    const stack = new Error().stack;
    const callerLine = stack.split("\n")[2]?.trim() || "unknown";

    const trace = {
      timestamp: new Date().toISOString(),
      message,
      data: data
        ? typeof data === "object"
          ? JSON.stringify(data, null, 2)
          : String(data)
        : null,
      caller: callerLine,
    };

    this.traces.push(trace);

    // Colorized console output
    console.log("\x1b[36m%s\x1b[0m", `🔍 [DEBUG] ${message}`);
    if (data) {
      console.log("\x1b[90m%s\x1b[0m", `   Data:`, data);
    }
    console.log("\x1b[90m%s\x1b[0m", `   Called from: ${callerLine}`);

    // Write to file if too many traces
    if (this.traces.length > 100) {
      this.flush();
    }
  }

  // Flush traces to file
  flush() {
    if (this.traces.length === 0) return;

    const content = this.traces.map((t) => JSON.stringify(t)).join("\n");
    fs.appendFileSync(this.traceFile, content + "\n");
    this.traces = [];
  }

  // Create a performance marker
  mark(label) {
    if (!this.enabled) return;
    const mark = {
      label,
      timestamp: Date.now(),
      memory: process.memoryUsage().heapUsed,
    };
    console.log(
      "\x1b[35m%s\x1b[0m",
      `⏱️ [PERF] ${label} - Memory: ${(mark.memory / 1024 / 1024).toFixed(2)}MB`,
    );
    return mark;
  }

  // Measure time between marks
  measure(startMark, endMark) {
    if (!this.enabled || !startMark || !endMark) return;
    const duration = endMark.timestamp - startMark.timestamp;
    console.log(
      "\x1b[35m%s\x1b[0m",
      `⏱️ [PERF] ${startMark.label} -> ${endMark.label}: ${duration}ms`,
    );
    return duration;
  }

  // Inspect an object deeply
  inspect(obj, label = "Inspect") {
    if (!this.enabled) return;
    console.log("\x1b[36m%s\x1b[0m", `🔍 [INSPECT] ${label}:`);
    console.log(require("util").inspect(obj, { colors: true, depth: 5 }));
  }
}

module.exports = new debuggerUtil();
