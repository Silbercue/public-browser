/**
 * Story 12.1 (Task 4.1): Type-shape validation for cortex types.
 *
 * Verifies that CortexPattern and ToolCallEvent interfaces contain all
 * required fields and that constants are exported with correct values.
 */
import { describe, it, expect } from "vitest";
import type { CortexPattern, ToolCallEvent } from "./cortex-types.js";
import {
  MIN_SEQUENCE_LENGTH,
  MAX_SEQUENCE_LENGTH,
  SEQUENCE_TIMEOUT_MS,
} from "./cortex-types.js";

describe("cortex-types (Story 12.1)", () => {
  describe("CortexPattern shape", () => {
    it("has all required fields with correct types", () => {
      const pattern: CortexPattern = {
        domain: "example.com",
        pathPattern: "/users/:id/profile",
        toolSequence: ["navigate", "view_page", "click"],
        outcome: "success",
        contentHash: "a1b2c3d4e5f6a7b8",
        timestamp: Date.now(),
      };

      expect(pattern.domain).toBe("example.com");
      expect(pattern.pathPattern).toBe("/users/:id/profile");
      expect(pattern.toolSequence).toEqual(["navigate", "view_page", "click"]);
      expect(pattern.outcome).toBe("success");
      expect(pattern.contentHash).toBe("a1b2c3d4e5f6a7b8");
      expect(typeof pattern.timestamp).toBe("number");
    });

    it("outcome is constrained to 'success'", () => {
      const pattern: CortexPattern = {
        domain: "test.com",
        pathPattern: "/",
        toolSequence: ["navigate", "view_page"],
        outcome: "success",
        contentHash: "0000000000000000",
        timestamp: 0,
      };
      expect(pattern.outcome).toBe("success");
    });
  });

  describe("ToolCallEvent shape", () => {
    it("has all required fields with correct types", () => {
      const event: ToolCallEvent = {
        toolName: "click",
        timestamp: Date.now(),
        domain: "example.com",
        path: "/users/123/profile",
        contentHash: "a1b2c3d4e5f6a7b8",
      };

      expect(event.toolName).toBe("click");
      expect(typeof event.timestamp).toBe("number");
      expect(event.domain).toBe("example.com");
      expect(event.path).toBe("/users/123/profile");
      expect(event.contentHash).toBe("a1b2c3d4e5f6a7b8");
    });
  });

  describe("Constants", () => {
    it("MIN_SEQUENCE_LENGTH is 2", () => {
      expect(MIN_SEQUENCE_LENGTH).toBe(2);
    });

    it("MAX_SEQUENCE_LENGTH is 20", () => {
      expect(MAX_SEQUENCE_LENGTH).toBe(20);
    });

    it("SEQUENCE_TIMEOUT_MS is 60_000", () => {
      expect(SEQUENCE_TIMEOUT_MS).toBe(60_000);
    });
  });
});
