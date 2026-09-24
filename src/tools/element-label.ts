/**
 * S3: One-line label of an element — `[e12] button "Save"` — shared by click
 * answers and ambiguous-selector errors, so the model sees what a tool
 * actually hit (or would have hit) in the same notation view_page uses.
 */
export function formatElementLabel(ref: string | undefined, role: string, name: string): string {
  const shown = name.length > 60 ? `${name.slice(0, 57)}...` : name;
  return `${ref ? `[${ref}] ` : ""}${role || "element"}${shown ? ` "${shown}"` : ""}`;
}
