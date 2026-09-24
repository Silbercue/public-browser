import { describe, it, expect } from "vitest";
import { formatElementLabel } from "./element-label.js";

describe("formatElementLabel (S3)", () => {
  it("writes ref, role and name the way view_page does", () => {
    expect(formatElementLabel("e12", "button", "Save")).toBe('[e12] button "Save"');
  });

  it("leaves out what is unknown and never prints an empty role", () => {
    expect(formatElementLabel(undefined, "button#save", "")).toBe("button#save");
    expect(formatElementLabel(undefined, "", "")).toBe("element");
  });

  it("shortens long names to 60 characters", () => {
    const label = formatElementLabel("e3", "link", "x".repeat(80));
    expect(label).toBe(`[e3] link "${"x".repeat(57)}..."`);
  });
});
