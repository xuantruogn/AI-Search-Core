import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile(".env");

const required = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
];

const missing = required.filter(
  (name) => !process.env[name]?.trim(),
);

if (missing.length > 0) {
  console.error(
    "[STARTUP] Missing required production environment variables:",
    missing.join(", "),
  );
  process.exit(1);
}

const executable =
  process.platform === "win32"
    ? "react-router-serve.cmd"
    : "react-router-serve";

const child = spawn(
  executable,
  ["./build/server/index.js"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("error", (error) => {
  console.error("[STARTUP] Failed to launch react-router-serve:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
