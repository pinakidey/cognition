import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logInfo, logWarn, logError } from "../src/services/logger";

describe("Structured logger", () => {
  let consoleSpy: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logInfo emits structured JSON to console.log", () => {
    logInfo("test_action", { key: "value" });
    expect(consoleSpy.log).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.log.mock.calls[0][0]);
    expect(output.level).toBe("info");
    expect(output.action).toBe("test_action");
    expect(output.key).toBe("value");
    expect(output.ts).toBeDefined();
  });

  it("logWarn emits to console.warn", () => {
    logWarn("warning_action");
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.warn.mock.calls[0][0]);
    expect(output.level).toBe("warn");
  });

  it("logError captures error message and stack", () => {
    const err = new Error("test error");
    logError("error_action", err, { context: "test" });
    expect(consoleSpy.error).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.level).toBe("error");
    expect(output.error).toBe("test error");
    expect(output.stack).toBeDefined();
    expect(output.context).toBe("test");
  });

  it("logError handles non-Error objects", () => {
    logError("error_action", "string error");
    expect(consoleSpy.error).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(output.error).toBe("string error");
    expect(output.stack).toBeUndefined();
  });
});
