import type { Person, TreeData, Union } from "../types";
import type { LiveRelative } from "./api";

/**
 * People the archivist approved since the last deploy, hung on the record.
 *
 * Runs before layout, so an approved person is drawn exactly like anyone in
 * tree.json: their own card, their own lines. Anyone already folded into
 * tree.json (same id) is skipped, so this can be merged into the record at
 * leisure without anyone appearing twice.
 */
export function applyAdditions(record: TreeData, added: LiveRelative[]): TreeData {
  if (!added.length) return record;

  const people = record.people.slice();
  const unions: Union[] = record.unions.map((u) => ({
    ...u,
    partners: u.partners.slice(),
    children: u.children.slice(),
  }));
  const byId = new Map(people.map((p) => [p.id, p]));

  const parentUnionOf = (id: string) => unions.find((u) => u.children.includes(id));
  const unionsOf = (id: string) => unions.filter((u) => u.partners.includes(id));

  for (const r of added) {
    const anchor = byId.get(r.personId);
    if (byId.has(r.id) || !anchor) continue;

    const person: Person = {
      id: r.id,
      name: r.name,
      born: r.born,
      bornPlace: r.bornPlace,
      died: r.died,
      blurb: r.blurb,
      sex: "U",
      // A child or sibling carries the family line's colour; someone who
      // married in, or a newly found parent, starts as "other".
      branch: r.relationship === "child" || r.relationship === "sibling" ? anchor.branch : "other",
      tags: ["Added by the family"],
    };

    if (r.relationship === "child") {
      const theirs = unionsOf(r.personId);
      const union =
        (r.otherParentId &&
          theirs.find((u) => u.partners.includes(r.otherParentId!))) ||
        // With no other parent named, the most recent partnership.
        theirs[theirs.length - 1];
      if (union) union.children.push(r.id);
      else unions.push({ id: `u-${r.id}`, partners: [r.personId], children: [r.id] });
    } else if (r.relationship === "partner") {
      unions.push({ id: `u-${r.id}`, partners: [r.personId, r.id], children: [] });
    } else if (r.relationship === "parent") {
      const existing = parentUnionOf(r.personId);
      if (existing && existing.partners.length < 2) existing.partners.push(r.id);
      else if (!existing) unions.push({ id: `u-${r.id}`, partners: [r.id], children: [r.personId] });
      else continue; // Already two parents; the API refuses this, so it is stale.
    } else if (r.relationship === "sibling") {
      const existing = parentUnionOf(r.personId);
      if (!existing) continue; // No parents to hang from; the API refuses this.
      existing.children.push(r.id);
    } else {
      continue;
    }

    people.push(person);
    byId.set(person.id, person);
  }

  return { ...record, people, unions };
}
