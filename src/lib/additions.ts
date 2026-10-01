// Applies approved people from gallery.json onto tree.json, before layout.
//
// Call it wherever tree.json and gallery.json are already merged:
//
//   const tree = applyAdditions(record, gallery.additions ?? []);
//
// ASSUMPTIONS: people have `id`; unions have `id`, `partners: string[]`,
// `children: string[]`. Rename the Person fields below to match tree.json.

export interface Person {
  id: string;
  name: string;
  born?: string;
  birthPlace?: string;
  died?: string;
  deathPlace?: string;
  [key: string]: unknown;
}

export interface Union {
  id: string;
  partners: string[];
  children: string[];
  [key: string]: unknown;
}

export interface Tree {
  people: Person[];
  unions: Union[];
}

export interface Addition {
  submissionId: string;
  op: "addChild" | "addPartner";
  relativeId: string;
  unionId: string | null;
  person: Person;
}

export function applyAdditions(record: Tree, additions: Addition[]): Tree {
  // Copy so the shipped record is never mutated.
  const people = record.people.slice();
  const unions = record.unions.map((u) => ({
    ...u, partners: u.partners.slice(), children: u.children.slice(),
  }));
  const ids = new Set(people.map((p) => p.id));

  for (const a of additions) {
    if (ids.has(a.person.id)) continue;      // already folded into tree.json
    if (!ids.has(a.relativeId)) {
      console.warn("Addition skipped, relative not found:", a);
      continue;
    }

    people.push({ ...a.person, live: true });
    ids.add(a.person.id);

    if (a.op === "addChild") {
      const theirs = unions.filter((u) => u.partners.includes(a.relativeId));
      const union =
        theirs.find((u) => u.id === a.unionId) ??
        // With several marriages and no union named, use the most recent one.
        // The form should send unionId whenever the parent has more than one.
        theirs[theirs.length - 1];

      if (union) {
        union.children.push(a.person.id);
      } else {
        unions.push({
          id: `live-u-${a.submissionId}`,
          partners: [a.relativeId],
          children: [a.person.id],
        });
      }
    } else {
      unions.push({
        id: `live-u-${a.submissionId}`,
        partners: [a.relativeId, a.person.id],
        children: [],
      });
    }
  }

  return { people, unions };
}
