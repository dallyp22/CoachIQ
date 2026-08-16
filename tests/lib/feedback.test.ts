import { describe, it, expect } from "vitest";
import {
  STAGE_ORDER,
  ALL_STAGES,
  stageIndex,
  isTerminalStage,
  isDeclined,
  isValidStage,
  isValidType,
  isValidPriority,
} from "@/lib/feedback";

describe("feedback stage vocabulary", () => {
  it("keeps SUBMITTED first and SHIPPED last on the linear rail", () => {
    expect(STAGE_ORDER[0]).toBe("SUBMITTED");
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe("SHIPPED");
  });

  it("excludes DECLINED from the linear order but includes it in ALL_STAGES", () => {
    expect(STAGE_ORDER).not.toContain("DECLINED");
    expect(ALL_STAGES).toContain("DECLINED");
    // ALL_STAGES is the rail plus exactly one terminal off-rail stage.
    expect(ALL_STAGES.length).toBe(STAGE_ORDER.length + 1);
  });

  it("returns -1 for DECLINED so it can never be rendered as a rail position", () => {
    expect(stageIndex("DECLINED")).toBe(-1);
    expect(stageIndex("SUBMITTED")).toBe(0);
    expect(stageIndex("INVESTIGATING")).toBe(2);
  });

  it("treats SHIPPED and DECLINED as terminal, nothing else", () => {
    expect(isTerminalStage("SHIPPED")).toBe(true);
    expect(isTerminalStage("DECLINED")).toBe(true);
    expect(isTerminalStage("PLANNED")).toBe(false);
    expect(isTerminalStage("SUBMITTED")).toBe(false);
    expect(isDeclined("DECLINED")).toBe(true);
    expect(isDeclined("SHIPPED")).toBe(false);
  });

  it("validates enum inputs from request bodies", () => {
    expect(isValidStage("PLANNED")).toBe(true);
    expect(isValidStage("DECLINED")).toBe(true);
    expect(isValidStage("bogus")).toBe(false);
    expect(isValidStage(3)).toBe(false);

    expect(isValidType("BUG")).toBe(true);
    expect(isValidType("FEATURE")).toBe(true);
    expect(isValidType("QUESTION")).toBe(false);

    expect(isValidPriority("URGENT")).toBe(true);
    expect(isValidPriority("")).toBe(false);
    expect(isValidPriority(null)).toBe(false);
  });
});
