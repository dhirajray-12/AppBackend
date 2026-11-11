// backend/scripts/analyzeErrors.js - Run this to analyze errors
// Usage: node scripts/analyzeErrors.js

const fs = require("fs");
const path = require("path");

const ERROR_LOG_DIR = path.join(__dirname, "../logs/errors");
const CRASH_LOG = path.join(__dirname, "../logs/crash.log");

function analyzeErrors() {
  console.log("\n📊 ERROR ANALYSIS REPORT\n");
  console.log("=".repeat(60));

  // Check if error directory exists
  if (!fs.existsSync(ERROR_LOG_DIR)) {
    console.log("❌ No error logs found. Directory does not exist.");
    return;
  }

  // Read all error log files
  const files = fs.readdirSync(ERROR_LOG_DIR).filter((f) => f.endsWith(".log"));

  if (files.length === 0) {
    console.log("✅ No error logs found. System is clean!");
    return;
  }

  console.log(`📁 Found ${files.length} error log files\n`);

  // Parse all errors
  const allErrors = [];

  files.forEach((file) => {
    const content = fs.readFileSync(path.join(ERROR_LOG_DIR, file), "utf8");
    const errors = content.split("---\n").filter((e) => e.trim());
    errors.forEach((error) => {
      try {
        const parsed = JSON.parse(error);
        allErrors.push(parsed);
      } catch (e) {
        // Skip invalid JSON
      }
    });
  });

  // Group by error type
  const errorTypes = {};
  const errorMessages = {};
  const errorStacks = {};

  allErrors.forEach((error) => {
    const type = error.name || "UnknownError";
    errorTypes[type] = (errorTypes[type] || 0) + 1;

    const message = error.message;
    const key = `${type}:${message}`;
    errorMessages[key] = (errorMessages[key] || 0) + 1;

    if (error.stack) {
      // Extract first line of stack trace
      const firstStackLine = error.stack.split("\n")[1]?.trim() || "unknown";
      if (!errorStacks[type]) {
        errorStacks[type] = new Set();
      }
      errorStacks[type].add(firstStackLine);
    }
  });

  // Display results
  console.log("🔴 ERROR TYPES:");
  Object.entries(errorTypes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`   ${type}: ${count} occurrences`);
      if (errorStacks[type]) {
        console.log(`      Common locations:`);
        Array.from(errorStacks[type])
          .slice(0, 3)
          .forEach((location) => {
            console.log(`        - ${location}`);
          });
      }
    });

  console.log("\n📝 MOST FREQUENT ERRORS:");
  Object.entries(errorMessages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([key, count]) => {
      console.log(`   ${count}x: ${key}`);
    });

  // Check for crash log
  if (fs.existsSync(CRASH_LOG)) {
    console.log("\n💥 CRASH LOG FOUND!");
    const crashContent = fs.readFileSync(CRASH_LOG, "utf8");
    const crashes = crashContent.split("---\n").filter((c) => c.trim());
    console.log(`   Total crashes: ${crashes.length}`);

    // Show last crash
    if (crashes.length > 0) {
      const lastCrash = JSON.parse(crashes[crashes.length - 1]);
      console.log(`\n   Last crash: ${lastCrash.timestamp}`);
      console.log(`   Error: ${lastCrash.error?.message || "Unknown"}`);
      console.log(
        `   Stack: ${lastCrash.error?.stack?.split("\n")[1]?.trim() || "No stack"}`,
      );
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(
    `📊 Summary: ${allErrors.length} total errors, ${Object.keys(errorTypes).length} unique error types`,
  );
}

// Run analysis
analyzeErrors();
