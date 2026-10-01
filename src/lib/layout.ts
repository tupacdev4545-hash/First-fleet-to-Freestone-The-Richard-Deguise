import type { Person, TreeData, Union } from "../types";

export const CARD_W = 250;
export const CARD_H = 118;
export const SPOUSE_GAP = 26;
export const SIBLING_GAP = 42;
export const ROW_H = 345;

interface UnionGroup {
  unionId: string;
  /** Index into node.members of the partner this union hangs from. */
  anchorIndex: number;
  spouseId: string | null;
  /** Index into node.members, or -1 when the spouse is drawn elsewhere. */
  spouseIndex: number;
  children: FamilyNode[];
  /** Children already drawn elsewhere in the tree. */
  ghostChildren: string[];
}

interface FamilyNode {
  pid: string;
  depth: number;
  x: number;
  width: number;
  members: string[];
  groups: UnionGroup[];
  children: FamilyNode[];
}

export interface PlacedPerson {
  person: Person;
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export type LinkKind = "marriage" | "descent" | "cross";

export interface Link {
  id: string;
  kind: LinkKind;
  d: string;
}

export interface Layout {
  placed: Map<string, PlacedPerson>;
  order: PlacedPerson[];
  links: Link[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** personId -> ids of parents, partners and children, for highlighting. */
  relatives: Map<string, Set<string>>;
}

function index(data: TreeData) {
  const people = new Map<string, Person>();
  for (const p of data.people) people.set(p.id, p);

  const unionsOf = new Map<string, Union[]>();
  const parentUnion = new Map<string, Union>();
  for (const u of data.unions) {
    for (const pid of u.partners) {
      if (!unionsOf.has(pid)) unionsOf.set(pid, []);
      unionsOf.get(pid)!.push(u);
    }
    for (const c of u.children) parentUnion.set(c, u);
  }
  return { people, unionsOf, parentUnion };
}

function shiftTree(node: FamilyNode, dx: number) {
  node.x += dx;
  for (const c of node.children) shiftTree(c, dx);
}

export function buildLayout(data: TreeData): Layout {
  const { people, unionsOf, parentUnion } = index(data);
  const placedIds = new Set<string>();
  const usedUnions = new Set<string>();

  function build(pid: string, depth: number): FamilyNode {
    placedIds.add(pid);
    const node: FamilyNode = {
      pid,
      // The row comes from the generation worked out across the whole graph,
      // not from how deep the recursion happens to be. Those differ whenever
      // someone married in: a man reached as his wife's spouse would otherwise
      // inherit her row, and his own newly-added father would land beside him
      // instead of above him.
      depth: generation.get(pid) ?? depth,
      x: 0,
      width: CARD_W,
      members: [pid],
      groups: [],
      children: [],
    };

    // Walk the members list as it grows: a spouse who married in may bring
    // their own earlier union (a child from a previous relationship), and
    // that union belongs on this node too.
    for (let i = 0; i < node.members.length; i++) {
      const anchorId = node.members[i];
      for (const u of unionsOf.get(anchorId) ?? []) {
        if (usedUnions.has(u.id)) continue;
        usedUnions.add(u.id);

        const spouseId = u.partners.find((p) => p !== anchorId) ?? null;
        let spouseIndex = -1;
        if (spouseId && people.has(spouseId) && !placedIds.has(spouseId)) {
          placedIds.add(spouseId);
          node.members.push(spouseId);
          spouseIndex = node.members.length - 1;
        }

        const group: UnionGroup = {
          unionId: u.id,
          anchorIndex: i,
          spouseId,
          spouseIndex,
          children: [],
          ghostChildren: [],
        };

        for (const cid of u.children) {
          if (!people.has(cid)) continue;
          if (placedIds.has(cid)) group.ghostChildren.push(cid);
          else group.children.push(build(cid, depth + 1));
        }

        node.groups.push(group);
        node.children.push(...group.children);
      }
    }

    node.width =
      node.members.length * CARD_W + (node.members.length - 1) * SPOUSE_GAP;
    return node;
  }

  // Which row each person belongs on, worked out from the graph rather than
  // from the order they happen to sit in the file.
  //
  // This is what lets the tree grow *upwards*. Add a father for Richard Guise
  // and he is no longer the top of the chart — but his wife still has no
  // parents recorded, so in file order she would be built first, at row zero,
  // dragging Richard back up beside her and leaving his father nowhere to go.
  // Working the generations out first, then building the highest ancestors
  // first, means another family can graft their history on above this one and
  // the chart simply gets taller.
  const generation = new Map<string, number>();
  for (const p of data.people) generation.set(p.id, 0);
  // Relaxation: spouses share a row, a child sits one below its parents.
  // Converges in as many passes as the tree is deep; the guard is only there
  // so a cycle in bad data cannot spin forever.
  for (let pass = 0; pass < data.people.length; pass++) {
    let changed = false;
    for (const u of data.unions) {
      let row = 0;
      for (const pid of u.partners) row = Math.max(row, generation.get(pid) ?? 0);
      for (const pid of u.partners) {
        if ((generation.get(pid) ?? 0) < row) {
          generation.set(pid, row);
          changed = true;
        }
      }
      for (const cid of u.children) {
        if (!people.has(cid)) continue;
        if ((generation.get(cid) ?? 0) < row + 1) {
          generation.set(cid, row + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Blood roots first (people with no parents recorded), then anything
  // orphaned. Highest generation first, so an ancestor is never built after
  // their own descendants have already claimed the rows.
  const roots: FamilyNode[] = [];
  const byGeneration = data.people
    .map((p, i) => ({ p, i }))
    // Sort is on (generation, original position), so people on the same row
    // keep the order the file gives them and the existing chart is unchanged.
    .sort(
      (a, b) =>
        (generation.get(a.p.id) ?? 0) - (generation.get(b.p.id) ?? 0) ||
        a.i - b.i,
    )
    .map(({ p }) => p);

  for (const p of byGeneration) {
    if (!placedIds.has(p.id) && !parentUnion.has(p.id)) {
      roots.push(build(p.id, generation.get(p.id) ?? 0));
    }
  }
  for (const p of byGeneration) {
    if (!placedIds.has(p.id)) {
      roots.push(build(p.id, generation.get(p.id) ?? 0));
    }
  }

  // Tidy pass: children first, then centre each parent block over them.
  let cursor = 0;
  function assign(node: FamilyNode) {
    if (node.children.length === 0) {
      node.x = cursor;
      cursor += node.width + SIBLING_GAP;
      return;
    }
    for (const c of node.children) assign(c);

    let first = node.children[0];
    let last = node.children[node.children.length - 1];
    let span = last.x + last.width - first.x;

    if (node.width > span) {
      const shift = (node.width - span) / 2;
      for (const c of node.children) shiftTree(c, shift);
      cursor += node.width - span;
      first = node.children[0];
      last = node.children[node.children.length - 1];
      span = last.x + last.width - first.x;
    }
    node.x = first.x + (span - node.width) / 2;
  }
  for (const r of roots) {
    assign(r);
    cursor += SIBLING_GAP * 2;
  }

  // Flatten into drawable geometry.
  const placed = new Map<string, PlacedPerson>();
  const order: PlacedPerson[] = [];
  const links: Link[] = [];
  const relatives = new Map<string, Set<string>>();

  const relate = (a: string, b: string) => {
    if (!relatives.has(a)) relatives.set(a, new Set());
    if (!relatives.has(b)) relatives.set(b, new Set());
    relatives.get(a)!.add(b);
    relatives.get(b)!.add(a);
  };

  const memberX = (node: FamilyNode, i: number) =>
    node.x + i * (CARD_W + SPOUSE_GAP);

  function emit(node: FamilyNode) {
    const y = node.depth * ROW_H;
    node.members.forEach((mid, i) => {
      const person = people.get(mid)!;
      const x = memberX(node, i);
      const item: PlacedPerson = {
        person,
        x,
        y,
        cx: x + CARD_W / 2,
        cy: y + CARD_H / 2,
      };
      placed.set(mid, item);
      order.push(item);
    });

    for (const g of node.groups) {
      const anchorId = node.members[g.anchorIndex];
      const selfCx = memberX(node, g.anchorIndex) + CARD_W / 2;
      let unionCx = selfCx;

      if (g.spouseIndex >= 0) {
        const spouseCx = memberX(node, g.spouseIndex) + CARD_W / 2;
        unionCx = (selfCx + spouseCx) / 2;
        const barY = y + CARD_H / 2;
        const left = Math.min(selfCx, spouseCx) + CARD_W / 2 - 4;
        const right = Math.max(selfCx, spouseCx) - CARD_W / 2 + 4;
        links.push({
          id: `m-${g.unionId}`,
          kind: "marriage",
          d: `M ${left} ${barY} L ${right} ${barY}`,
        });
        relate(anchorId, g.spouseId!);
      }

      const kids = g.children.map((c) => ({
        node: c,
        cx: memberX(c, c.members.indexOf(c.pid)) + CARD_W / 2,
      }));

      if (kids.length) {
        const busY = y + CARD_H + (ROW_H - CARD_H) / 2;
        const childTop = (node.depth + 1) * ROW_H;
        const xs = kids.map((k) => k.cx);
        const minCx = Math.min(...xs, unionCx);
        const maxCx = Math.max(...xs, unionCx);
        links.push({
          id: `d-${g.unionId}-stem`,
          kind: "descent",
          d: `M ${unionCx} ${y + CARD_H} L ${unionCx} ${busY}`,
        });
        if (kids.length > 1 || Math.abs(xs[0] - unionCx) > 0.5) {
          links.push({
            id: `d-${g.unionId}-bus`,
            kind: "descent",
            d: `M ${minCx} ${busY} L ${maxCx} ${busY}`,
          });
        }
        for (const k of kids) {
          links.push({
            id: `d-${g.unionId}-${k.node.pid}`,
            kind: "descent",
            d: `M ${k.cx} ${busY} L ${k.cx} ${childTop}`,
          });
          relate(anchorId, k.node.pid);
          if (g.spouseId) relate(g.spouseId, k.node.pid);
        }
      }
    }

    for (const c of node.children) emit(c);
  }

  for (const r of roots) emit(r);

  // Second pass: links whose endpoints live in different subtrees.
  function emitCross(node: FamilyNode) {
    for (const g of node.groups) {
      const anchorId = node.members[g.anchorIndex];
      if (g.spouseIndex < 0 && g.spouseId && placed.has(g.spouseId)) {
        const a = placed.get(anchorId)!;
        const b = placed.get(g.spouseId)!;
        links.push({
          id: `x-${g.unionId}`,
          kind: "cross",
          d: curve(a.cx, a.cy, b.cx, b.cy),
        });
        relate(anchorId, g.spouseId);
      }
      for (const cid of g.ghostChildren) {
        const a = placed.get(anchorId)!;
        const b = placed.get(cid);
        if (!b) continue;
        links.push({
          id: `x-${g.unionId}-${cid}`,
          kind: "cross",
          d: curve(a.cx, a.cy, b.cx, b.cy),
        });
        relate(anchorId, cid);
      }
    }
    for (const c of node.children) emitCross(c);
  }
  for (const r of roots) emitCross(r);

  const bounds = order.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x + CARD_W),
      maxY: Math.max(acc.maxY, p.y + CARD_H),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

  if (!order.length) {
    bounds.minX = 0;
    bounds.minY = 0;
    bounds.maxX = CARD_W;
    bounds.maxY = CARD_H;
  }

  return { placed, order, links, bounds, relatives };
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  const dip = Math.min(90, Math.abs(x2 - x1) * 0.25 + 24);
  const my = Math.max(y1, y2) + dip;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}
