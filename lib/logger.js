// lib/logger.js — بديل بسيط لـ logging.getLogger(name) في Python
import { config } from "../config.js";

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const currentLevel = LEVELS[config.LOG_LEVEL] ?? LEVELS.INFO;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function getLogger(name) {
  const log = (level, ...args) => {
    if (LEVELS[level] < currentLevel) return;
    const fn = level === "ERROR" ? console.error : level === "WARNING" ? console.warn : console.log;
    fn(`${ts()} [${name}] ${level} ${args.map((a) => (a instanceof Error ? a.stack : a)).join(" ")}`);
  };
  return {
    debug: (...a) => log("DEBUG", ...a),
    info: (...a) => log("INFO", ...a),
    warning: (...a) => log("WARNING", ...a),
    warn: (...a) => log("WARNING", ...a),
    error: (...a) => log("ERROR", ...a),
    exception: (...a) => log("ERROR", ...a),
  };
}
