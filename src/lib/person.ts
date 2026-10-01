import type { Person } from "../types";

export function initials(name: string) {
  const parts = name
    .replace(/\(.*?\)/g, "")
    .split(/\s+/)
    .filter((w) => w.length && !/^(de|von|van|la|le|du|of|the)$/i.test(w));
  if (!parts.length) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export function lifespan(p: Person) {
  const b = p.born?.trim();
  const d = p.died?.trim();
  const clean = (v?: string) => (!v || v === "?" ? "?" : v);
  if (b && d) return `${clean(b)} – ${clean(d)}`;
  // Known to have died, date not recorded.
  if (b && p.deceased) return `${clean(b)} – d.`;
  if (b) return `b. ${clean(b)}`;
  if (d) return `d. ${clean(d)}`;
  return p.deceased ? "died, date unknown" : "";
}

/**
 * Whether the record says this person has died. Used to keep questions about
 * how a partnership ended away from people who are still alive.
 */
export function hasDied(p: Person) {
  if (p.deceased) return true;
  const d = p.died?.trim();
  return Boolean(d && d !== "?");
}

/** The line the tree descends along, in generational order. */
export const LINE_BRANCHES = [
  "guise",
  "brownlow",
  "bradney",
  "jones",
  "rock",
] as const;

/** Families that married in and left descendants of their own. */
export const MARRIED_IN_BRANCHES = [
  "freestone",
  "staber",
  "bastock",
  "hayes",
  "mcenally",
  "mckenzie",
  "goodwin",
  "ritchie",
  "johnston",
  "taylor",
  "touzell",
  "mciver",
  "newton",
  "robson",
  "browne",
] as const;

export const BRANCH_ORDER = [
  ...LINE_BRANCHES,
  ...MARRIED_IN_BRANCHES,
  "other",
] as const;

export function branchColor(branch?: string) {
  const id = BRANCH_ORDER.includes(branch as never) ? branch : "other";
  return `var(--branch-${id})`;
}

export const BRANCH_LABELS: Record<string, string> = {
  guise: "Guise",
  brownlow: "Brownlow",
  bradney: "Bradney",
  jones: "Jones",
  rock: "Rock",
  freestone: "Freestone",
  staber: "Staber",
  bastock: "Bastock",
  hayes: "Hayes",
  mcenally: "McEnally",
  mckenzie: "McKenzie",
  goodwin: "Goodwin",
  ritchie: "Ritchie",
  johnston: "Johnston",
  taylor: "Taylor",
  touzell: "Touzell",
  mciver: "McIver",
  newton: "Newton",
  robson: "Robson",
  browne: "Browne",
  other: "Married in / no line here",
};

/** Trim a string to fit roughly `max` characters, adding an ellipsis. */
export function clamp(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Break a name across at most `maxLines` lines of roughly `max` characters,
 * ellipsising whatever still will not fit. Card text is SVG, so there is no
 * browser line-breaking to lean on.
 */
export function wrap(text: string, max: number, maxLines = 2): string[] {
  if (text.length <= max) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= max || !line) {
      line = next;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  const restIndex = lines.join(" ").length ? lines.join(" ").length + 1 : 0;
  const rest = text.slice(restIndex);
  lines.push(clamp(rest, max));
  return lines.slice(0, maxLines);
}

export function matches(p: Person, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const hay = [p.name, p.nee, p.born, p.died, p.bornPlace, p.diedPlace, ...(p.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return needle
    .split(/\s+/)
    .every((token) => hay.includes(token));
}
