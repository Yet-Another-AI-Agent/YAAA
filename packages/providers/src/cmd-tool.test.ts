import { describe, expect, it } from "vitest";
import { CmdTool } from "./cmd-tool.js";

describe("CmdTool", () => {
  it("returns stdout and stderr separately", async () => {
    const result = await new CmdTool().execute("printf out; printf err >&2");
    expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 0, timedOut: false });
  });

  it("terminates commands that exceed their timeout", async () => {
    const result = await new CmdTool().execute("sleep 2", { timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
  });
});
