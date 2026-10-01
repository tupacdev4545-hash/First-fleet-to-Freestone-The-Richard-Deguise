export type Sex = "M" | "F" | "U";

/** A branch/surname grouping used for colour-coding on the canvas. */
export type BranchId =
  // The descent line the tree is built on.
  | "guise"
  | "brownlow"
  | "bradney"
  | "jones"
  | "rock"
  // Families that married into it and left descendants of their own.
  | "freestone"
  | "staber"
  | "bastock"
  | "hayes"
  | "mcenally"
  | "mckenzie"
  | "goodwin"
  | "ritchie"
  | "johnston"
  | "taylor"
  | "touzell"
  | "mciver"
  | "newton"
  | "robson"
  | "browne"
  | "other";

export interface Photo {
  /** Path under /photos or a full URL. */
  src: string;
  caption?: string;
}

export interface Person {
  id: string;
  name: string;
  /** Maiden / birth surname, shown as "née" when different. */
  nee?: string;
  sex?: Sex;
  born?: string;
  bornPlace?: string;
  died?: string;
  diedPlace?: string;
  /** Short life blurb shown in the person panel. */
  blurb?: string;
  /** Up to 5 are shown in the gallery. */
  photos?: Photo[];
  /** Short chips: "First Fleet", "Convict", "Goulburn". */
  tags?: string[];
  branch?: BranchId;
  /** Set true where the record still needs a source. */
  unverified?: boolean;
  /** Where the claims about this person come from. */
  links?: { label: string; url: string }[];
  /** An open question about them, shown above the rival accounts. */
  question?: string;
  /** Competing accounts, laid out side by side. */
  accounts?: Account[];
  /** What evidence would decide between the accounts. */
  wouldSettleIt?: string;
  /**
   * They have died, but no date is recorded. Kept separate from `died` so the
   * tree never has to invent a date to register the fact.
   */
  deceased?: boolean;
}

/** One of several competing explanations of a person's history. */
export interface Account {
  /** "The French account", "The English account". */
  title: string;
  /** Where it comes from — family tradition, a database, a researcher. */
  source: string;
  summary: string;
  points: string[];
  /** A caution the reader needs before weighing this one. */
  caveat?: string;
}

export interface Union {
  id: string;
  /** One or two person ids. */
  partners: string[];
  children: string[];
  married?: string;
  marriedPlace?: string;
  /** How the partnership ended, where the family has said. */
  ended?: "divorced" | "separated" | "widowed" | "annulled";
  /** The partnership they were in at the end of their life. */
  final?: boolean;
}

export interface TreeData {
  title: string;
  subtitle?: string;
  /** The original chart sheets this data was transcribed from. */
  sources?: string[];
  people: Person[];
  unions: Union[];
}

/** Who is contributing, captured once and remembered for the session. */
export interface Contributor {
  name: string;
  email: string;
}

export type RelationshipKind =
  | "child"
  | "parent"
  | "partner"
  | "sibling";

/** What happened to a partnership the new one would displace. */
export type PartnershipOutcome =
  | "still-together"
  | "separated"
  | "divorced"
  | "widowed"
  | "chart-wrong";

/** Everything a visitor can propose. All of it queues for approval. */
export type Proposal =
  | {
      kind: "photo";
      personId: string;
      personName: string;
      caption?: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      /** S3 key once the file has been put; absent in preview-only mode. */
      storageKey?: string;
      /** Where the site will serve it from, e.g. /photos/live/xxx.jpg */
      publicPath?: string;
      /** The shared family passcode, checked by the API before publishing. */
      passcode?: string;
      /** So the archivist's email can carry a working removal link. */
      apiBase?: string;
      contributor: Contributor;
    }
  | {
      kind: "biography";
      personId: string;
      personName: string;
      text: string;
      previousText?: string;
      /**
       * The shared family passcode. Given and correct, the story goes up at
       * once; left blank, it queues for the archivist instead.
       */
      passcode?: string;
      /** So the archivist's email can carry a working take-down link. */
      apiBase?: string;
      contributor: Contributor;
    }
  | {
      kind: "relative";
      personId: string;
      personName: string;
      relationship: RelationshipKind;
      newPerson: {
        name: string;
        born?: string;
        died?: string;
        bornPlace?: string;
        blurb?: string;
      };
      /** Only for a partner who would displace one already recorded. */
      displaces?: {
        existingPartnerId: string;
        existingPartnerName: string;
        outcome: PartnershipOutcome;
        currentPartner?: string;
      };
      /**
       * Partners already recorded, when the form deliberately did not ask what
       * happened — because someone in that partnership is still living.
       */
      alsoRecordedWith?: string[];
      /** The other parent, when adding a child. */
      otherParentId?: string;
      contributor: Contributor;
      notes?: string;
    };
