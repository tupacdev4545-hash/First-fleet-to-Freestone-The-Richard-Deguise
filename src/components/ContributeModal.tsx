import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Contributor,
  PartnershipOutcome,
  Person,
  Proposal,
  RelationshipKind,
} from "../types";
import {
  hasBackend,
  MAX_PHOTO_BYTES,
  readPasscode,
  rememberPasscode,
  submitProposal,
} from "../lib/api";
import { hasDied, lifespan } from "../lib/person";

export type ContributeMode = "photo" | "biography" | "relative";

interface Props {
  mode: ContributeMode;
  person: Person | null;
  people: Person[];
  /** Partners already recorded for a person, used for the spouse question. */
  partnersOf: (id: string) => Person[];
  /**
   * What their life reads as on the site right now — the family's published
   * version where there is one, otherwise the record's own. Writers start from
   * this, so each one extends the last rather than talking past it.
   */
  currentStory?: string;
  contributor: Contributor;
  onContributor: (c: Contributor) => void;
  onDone: (
    proposal: Proposal,
    file?: File,
    previewUrl?: string,
    live?: boolean,
  ) => void;
  onClose: () => void;
}

const RELATIONSHIPS: { value: RelationshipKind; label: string }[] = [
  { value: "child", label: "a child of" },
  { value: "partner", label: "a spouse or partner of" },
  { value: "parent", label: "a parent of" },
  { value: "sibling", label: "a sibling of" },
];

const OUTCOMES: { value: PartnershipOutcome; label: string }[] = [
  { value: "widowed", label: "Widowed — that partner has died" },
  { value: "divorced", label: "Divorced" },
  { value: "separated", label: "Separated" },
  { value: "still-together", label: "Still together — this is an additional partner" },
  { value: "chart-wrong", label: "The tree has that partnership wrong" },
];

const TITLES: Record<ContributeMode, string> = {
  photo: "Add a photograph",
  biography: "Write their life story",
  relative: "Add a relative",
};

export default function ContributeModal({
  mode,
  person,
  people,
  partnersOf,
  currentStory,
  contributor,
  onContributor,
  onDone,
  onClose,
}: Props) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const firstField = useRef<HTMLElement>(null);

  // Photo
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [caption, setCaption] = useState("");
  const [passcode, setPasscode] = useState(readPasscode);

  // Biography
  const [bio, setBio] = useState(currentStory ?? person?.blurb ?? "");
  const [wentLive, setWentLive] = useState(false);

  // Relative
  const [anchorId, setAnchorId] = useState(person?.id ?? "");
  const [relationship, setRelationship] = useState<RelationshipKind>("child");
  const [outcome, setOutcome] = useState<PartnershipOutcome | "">("");
  const [currentPartner, setCurrentPartner] = useState("");
  const [otherParentId, setOtherParentId] = useState("");

  const anchor = useMemo(
    () => people.find((p) => p.id === anchorId) ?? null,
    [people, anchorId],
  );
  const existingPartners = anchor ? partnersOf(anchor.id) : [];
  // Asking a stranger to state how a marriage ended is fine for people long
  // dead and not fine for the living. The question only appears when everyone
  // in the existing partnership has a recorded death; otherwise the archivist
  // is told quietly and rings the family.
  const settledPartners =
    anchor && hasDied(anchor) ? existingPartners.filter(hasDied) : [];
  const addingPartner = relationship === "partner" && existingPartners.length > 0;
  const partnerConflict = addingPartner && settledPartners.length > 0;
  const partnerPrivate = addingPartner && settledPartners.length === 0;

  /**
   * Photographs and life stories go straight up for anyone holding the family
   * passcode. Anything that reshapes the tree still waits for the archivist.
   * A story with the passcode box left empty queues instead of publishing.
   */
  const publishesNow =
    hasBackend &&
    (mode === "photo" || (mode === "biography" && passcode.trim().length > 0));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function pickFile(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("That file is not an image.");
      return;
    }
    if (f.size > MAX_PHOTO_BYTES) {
      setError(
        `That photograph is ${(f.size / 1024 / 1024).toFixed(
          1,
        )} MB. The limit is 8 MB — try exporting it a bit smaller.`,
      );
      return;
    }
    setError("");
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const who: Contributor = {
      name: String(form.get("submitterName") ?? "").trim(),
      email: String(form.get("submitterEmail") ?? "").trim(),
    };
    onContributor(who);

    let proposal: Proposal;

    if (mode === "photo") {
      if (!file || !person) {
        setError("Choose a photograph first.");
        return;
      }
      proposal = {
        kind: "photo",
        personId: person.id,
        personName: person.name,
        caption: caption.trim() || undefined,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        contributor: who,
      };
    } else if (mode === "biography") {
      if (!person) return;
      proposal = {
        kind: "biography",
        personId: person.id,
        personName: person.name,
        text: bio.trim(),
        previousText: currentStory ?? person.blurb,
        contributor: who,
      };
    } else {
      if (!anchor) {
        setError("Choose who this person is related to.");
        return;
      }
      if (partnerConflict && !outcome) {
        setError("Tell us what happened to the partnership already recorded.");
        return;
      }
      const displacedId = String(form.get("existingPartnerId") ?? "");
      const displaced = settledPartners.find((p) => p.id === displacedId);
      proposal = {
        kind: "relative",
        personId: anchor.id,
        personName: anchor.name,
        relationship,
        newPerson: {
          name: String(form.get("personName") ?? "").trim(),
          born: String(form.get("born") ?? "").trim() || undefined,
          died: String(form.get("died") ?? "").trim() || undefined,
          bornPlace: String(form.get("bornPlace") ?? "").trim() || undefined,
          blurb: String(form.get("blurb") ?? "").trim() || undefined,
        },
        displaces:
          partnerConflict && displaced && outcome
            ? {
                existingPartnerId: displaced.id,
                existingPartnerName: displaced.name,
                outcome,
                currentPartner: currentPartner.trim() || undefined,
              }
            : undefined,
        alsoRecordedWith: partnerPrivate
          ? existingPartners.map((p) => p.name)
          : undefined,
        otherParentId: otherParentId || undefined,
        contributor: who,
        notes: String(form.get("notes") ?? "").trim() || undefined,
      };
    }

    setState("sending");
    setError("");
    try {
      const result = await submitProposal(
        proposal,
        file ?? undefined,
        passcode.trim(),
      );
      if (passcode.trim()) rememberPasscode(passcode.trim());
      setWentLive(Boolean(result.live));
      onDone(
        proposal,
        file ?? undefined,
        previewUrl || undefined,
        Boolean(result.live),
      );
      setState("sent");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const subject = person ?? anchor;
  // Match the button that opened it: you are adding to a story that exists.
  const title =
    mode === "biography" && (currentStory ?? person?.blurb)
      ? "Add to their story"
      : TITLES[mode];

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {state === "sent" ? (
          <>
            <h2>{wentLive ? "It is up" : "Thank you"}</h2>
            <p className="lede">
              {!hasBackend
                ? "It is showing on the page now. This copy of the tree has no archive connected yet, so it will not outlast the browser tab — but this is exactly how it will behave once the site is live."
                : wentLive
                  ? mode === "photo"
                    ? "The photograph is live on the tree. Anyone who opens the site will see it, right now, no waiting. The archivist gets a copy in case it ever needs taking down."
                    : "Their story is live on the tree. Anyone who opens the site reads your version from now on — and the next person to write starts from it, so it grows rather than gets replaced."
                  : "It has gone to the family archivist, who will pass it to a relative of that branch to confirm before it becomes part of the tree. You can see it on the page now, marked as pending."}
            </p>
            <div className="actions">
              <button className="btn primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>{title}</h2>
            <p className="lede">
              {subject ? (
                <>
                  For <strong>{subject.name}</strong>
                  {lifespan(subject) ? `, ${lifespan(subject)}` : ""}.{" "}
                  {publishesNow
                    ? "With the family passcode it goes up on the tree straight away, for everyone."
                    : "Anyone can contribute; a relative of that branch confirms it before it becomes part of the record."}
                </>
              ) : publishesNow ? (
                "With the family passcode it goes up on the tree straight away, for everyone."
              ) : (
                "Anyone can contribute. A relative of that branch confirms it before it becomes part of the record."
              )}
            </p>

            {mode === "photo" && (
              <>
                <div className="field">
                  <label htmlFor="photo">The photograph</label>
                  <label className={`dropzone${file ? " filled" : ""}`}>
                    <input
                      id="photo"
                      type="file"
                      accept="image/*"
                      onChange={(e) => pickFile(e.target.files?.[0])}
                    />
                    {previewUrl ? (
                      <img src={previewUrl} alt="" />
                    ) : (
                      <span>
                        <strong>Choose an image</strong>
                        <br />
                        JPEG, PNG or HEIC, up to 8 MB
                      </span>
                    )}
                  </label>
                  {file && (
                    <p className="note" style={{ marginTop: 6 }}>
                      {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="caption">Caption</label>
                  <input
                    id="caption"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="e.g. Goulburn, about 1952 — back row, second from left"
                  />
                </div>

              </>
            )}

            {mode === "biography" && (
              <div className="field">
                <label htmlFor="bio">Their life, in your words</label>
                <textarea
                  id="bio"
                  ref={firstField as React.Ref<HTMLTextAreaElement>}
                  rows={9}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Where they lived, what they did, who they were. Anything you know."
                />
                {(currentStory ?? person?.blurb) && (
                  <p className="note" style={{ marginTop: 6 }}>
                    This starts from what the tree says now. Edit it freely —
                    nothing is lost, every version is kept.
                  </p>
                )}
              </div>
            )}

            {hasBackend && (mode === "photo" || mode === "biography") && (
              <div className="field">
                <label htmlFor="passcode">Family passcode</label>
                <input
                  id="passcode"
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  autoComplete="off"
                  required={mode === "photo"}
                  placeholder={
                    mode === "photo"
                      ? "the word the family shares"
                      : "the word the family shares — or leave it blank"
                  }
                />
                <p className="note" style={{ marginTop: 6 }}>
                  {mode === "photo" ? (
                    <>
                      Typed once, then this browser remembers it. It is what
                      lets a photograph go up straight away instead of waiting
                      in a queue — and what keeps strangers out.
                    </>
                  ) : publishesNow ? (
                    <>
                      With this, their story goes up the moment you send it.
                      Typed once, then this browser remembers it.
                    </>
                  ) : (
                    <>
                      Family who have the passcode see their story go up
                      immediately. Without it you can still write — it goes to
                      the archivist first, which takes a little longer.
                    </>
                  )}
                </p>
              </div>
            )}

            {mode === "relative" && (
              <>
                <div className="row">
                  <div className="field">
                    <label htmlFor="relationship">The new person is</label>
                    <select
                      id="relationship"
                      value={relationship}
                      onChange={(e) => {
                        setRelationship(e.target.value as RelationshipKind);
                        setOutcome("");
                      }}
                    >
                      {RELATIONSHIPS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="anchorId">Someone already on the tree</label>
                    <select
                      id="anchorId"
                      value={anchorId}
                      onChange={(e) => {
                        setAnchorId(e.target.value);
                        setOutcome("");
                        setOtherParentId("");
                      }}
                      required
                    >
                      <option value="">— choose —</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {lifespan(p) ? ` (${lifespan(p)})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {partnerConflict && (
                  <div className="conflict">
                    <h3>
                      {anchor!.name} is already recorded with{" "}
                      {settledPartners.map((p) => p.name).join(" and ")}.
                    </h3>
                    <p>
                      A person can hold more than one partnership on a tree, so
                      nothing gets deleted — but the record should say what
                      happened.
                    </p>

                    {settledPartners.length > 1 && (
                      <div className="field">
                        <label htmlFor="existingPartnerId">
                          Which partnership does this change?
                        </label>
                        <select id="existingPartnerId" name="existingPartnerId">
                          {settledPartners.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {settledPartners.length === 1 && (
                      <input
                        type="hidden"
                        name="existingPartnerId"
                        value={settledPartners[0].id}
                      />
                    )}

                    <fieldset className="choices">
                      <legend>What happened?</legend>
                      {OUTCOMES.map((o) => (
                        <label key={o.value}>
                          <input
                            type="radio"
                            name="outcome"
                            value={o.value}
                            checked={outcome === o.value}
                            onChange={() => setOutcome(o.value)}
                          />
                          <span>{o.label}</span>
                        </label>
                      ))}
                    </fieldset>

                    {outcome && outcome !== "chart-wrong" && (
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label htmlFor="currentPartner">
                          Who is {anchor!.name.split(" ")[0]} with now?
                        </label>
                        <input
                          id="currentPartner"
                          value={currentPartner}
                          onChange={(e) => setCurrentPartner(e.target.value)}
                          placeholder={
                            outcome === "still-together"
                              ? "Both, if that is the case"
                              : "The person you are adding above, or someone else"
                          }
                        />
                      </div>
                    )}
                  </div>
                )}

                {partnerPrivate && (
                  <div className="quiet-note">
                    <p>
                      The tree already records {anchor!.name} with{" "}
                      {existingPartners.map((p) => p.name).join(" and ")}.
                      Nothing is removed by adding someone — a person can hold
                      more than one partnership on a tree.
                    </p>
                    <p>
                      We won't ask you what happened there. The archivist will
                      check with the family which partnership is current before
                      anything is published.
                    </p>
                  </div>
                )}

                {relationship === "child" && existingPartners.length > 1 && (
                  <div className="field">
                    <label htmlFor="otherParentId">The other parent</label>
                    <select
                      id="otherParentId"
                      value={otherParentId}
                      onChange={(e) => setOtherParentId(e.target.value)}
                    >
                      <option value="">— not sure —</option>
                      {existingPartners.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="personName">Their full name</label>
                  <input
                    id="personName"
                    name="personName"
                    required
                    placeholder="e.g. Elsie May Freestone"
                  />
                </div>
                <div className="row">
                  <div className="field">
                    <label htmlFor="born">Born</label>
                    <input id="born" name="born" placeholder="12-3-1903" />
                  </div>
                  <div className="field">
                    <label htmlFor="died">Died</label>
                    <input id="died" name="died" placeholder="1981, or leave blank" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="bornPlace">Born where</label>
                  <input id="bornPlace" name="bornPlace" placeholder="Goulburn, NSW" />
                </div>
                <div className="field">
                  <label htmlFor="blurb">A few lines about their life</label>
                  <textarea id="blurb" name="blurb" rows={3} />
                </div>
                <div className="field">
                  <label htmlFor="notes">
                    Anything else — sources, photographs you hold
                  </label>
                  <textarea id="notes" name="notes" rows={2} />
                </div>
              </>
            )}

            <div className="row">
              <div className="field">
                <label htmlFor="submitterName">Your name</label>
                <input
                  id="submitterName"
                  name="submitterName"
                  required
                  defaultValue={contributor.name}
                />
              </div>
              <div className="field">
                <label htmlFor="submitterEmail">Your email</label>
                <input
                  id="submitterEmail"
                  name="submitterEmail"
                  type="email"
                  required
                  defaultValue={contributor.email}
                />
              </div>
            </div>

            {!hasBackend && (
              <p className="note">
                This copy is a preview — nothing leaves your browser. On the
                live site it goes to the archivist for approval.
              </p>
            )}

            {error && <p className="error">{error}</p>}

            <div className="actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={state === "sending"}
              >
                {publishesNow
                  ? state === "sending"
                    ? "Putting it up…"
                    : "Put it up"
                  : state === "sending"
                    ? "Sending…"
                    : "Send for approval"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
