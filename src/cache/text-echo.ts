/**
 * Stufe 2 (H1 Diff-Hygiene, H2 kompakte Seitenansicht): which StaticText
 * children only repeat what their parent's line already shows — e.g.
 * `heading "T2.1 Wait for Async Content"` with the children
 * `StaticText "T2.1"` and `StaticText "Wait for Async Content"`.
 *
 * Rule (Plancheck P4): a parent's own text children are left out only when
 * their texts, joined in document order and compared without any
 * whitespace, give exactly the name printed on the parent's line. The name
 * was then built from exactly these texts, so nothing is lost: every
 * left-out text stands verbatim in that name. A name from aria-label,
 * aria-labelledby or title that the children do not spell out
 * ("Items: 10" over a child "0") drops nothing. No role list and no
 * `name.sources` are needed — the comparison itself shows whether the name
 * came from the content. There is no substring rule.
 *
 * Parent = nearest non-ignored AX ancestor. Own text children = every
 * non-ignored StaticText whose nearest non-ignored ancestor is that parent,
 * in document order: ignored wrappers are looked through, any other
 * non-ignored node is the parent of its own texts. The DOM diff (H1) and
 * view_page (H2) use this one definition, so a text never vanishes in one
 * place and stays in the other.
 *
 * Pure functions: no state, no CDP.
 */

/** The fields of an AX node the rule reads (an AXNode fits). */
export interface EchoNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  childIds?: string[];
}

function textOf(node: EchoNode): string {
  const value = node.name?.value;
  return typeof value === "string" ? value : "";
}

/** All whitespace removed: "T1.1 Click" equals "T1.1" + "Click", "Items: 10" equals "Items:" + "10". */
function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * true when `texts`, joined in order and compared without any whitespace,
 * give exactly `name`. Never true without texts or without a (non-blank) name.
 */
export function textsFormName(texts: readonly string[], name: string | undefined): boolean {
  if (texts.length === 0 || name === undefined) return false;
  const target = compact(name);
  return target.length > 0 && compact(texts.join("")) === target;
}

/**
 * The parent's own text children: every non-ignored StaticText whose nearest
 * non-ignored ancestor is `parent`, in document order (childIds order).
 */
export function ownTextChildren<N extends EchoNode>(parent: N, byId: ReadonlyMap<string, N>): N[] {
  const out: N[] = [];
  const visit = (node: N): void => {
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (child.ignored) visit(child);
      else if (child.role?.value === "StaticText") out.push(child);
    }
  };
  visit(parent);
  return out;
}

/**
 * The text children that only repeat `name`, the name printed on the
 * parent's line: all own text children when together they form it,
 * otherwise none.
 */
export function echoTextChildren<N extends EchoNode>(
  parent: N,
  name: string | undefined,
  byId: ReadonlyMap<string, N>,
): N[] {
  const texts = ownTextChildren(parent, byId);
  return textsFormName(texts.map(textOf), name) ? texts : [];
}
