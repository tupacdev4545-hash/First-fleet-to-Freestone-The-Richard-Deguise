import type { Person, Photo } from "../types";
import { BRANCH_LABELS, branchColor, lifespan } from "../lib/person";
import {
  claudeResearch,
  isHistorical,
  troveSearch,
  webSearch,
  type LivePhoto,
} from "../lib/api";
import type { ContributeMode } from "./ContributeModal";
import PhotoCarousel, { type CarouselPhoto } from "./PhotoCarousel";

export interface PendingRelative {
  name: string;
  relationship: string;
}

interface Props {
  person: Person;
  relatives: Person[];
  /** "divorced", "last partner" and so on, for the connected pills. */
  noteFor: (otherId: string) => string | undefined;
  /**
   * Photographs the family has published since the last deploy. Once added
   * they stay: only the archivist's take-down link can remove one.
   */
  livePhotos: LivePhoto[];
  /** The family's chosen main photo for this person, if they chose one. */
  primaryId?: string;
  onSetPrimary: (photoId: string, passcode: string) => Promise<void>;
  /** The life story the family has published, which supersedes the record. */
  liveStory?: { text: string; by?: string };
  /** Just uploaded from this browser, before the gallery is re-read. */
  pendingPhotos: Photo[];
  /** A life story contributed this session, awaiting approval. */
  pendingBio?: string;
  pendingRelatives: PendingRelative[];
  onClose: () => void;
  onGoTo: (id: string) => void;
  onContribute: (mode: ContributeMode) => void;
}

const MAX_PHOTOS = 5;

export default function PersonPanel({
  person,
  relatives,
  noteFor,
  livePhotos,
  primaryId,
  onSetPrimary,
  liveStory,
  pendingPhotos,
  pendingBio,
  pendingRelatives,
  onClose,
  onGoTo,
  onContribute,
}: Props) {
  // What their life reads as now: the family's published version where there
  // is one, otherwise whatever the transcribed record says.
  const story = liveStory?.text ?? person.blurb;
  // Trove stops at the 1950s, so what to lead with depends on when they lived.
  const historical = isHistorical(person);
  const photos: CarouselPhoto[] = [
    ...(person.photos ?? []).map((p) => ({ id: p.src, src: p.src, caption: p.caption })),
    ...livePhotos.map((p) => ({ id: p.id, src: p.src, caption: p.caption })),
    ...pendingPhotos.map((p, i) => ({
      id: `just-added-${i}`,
      src: p.src,
      caption: p.caption,
      justAdded: true,
    })),
  ].slice(0, MAX_PHOTOS);

  return (
    <aside
      className={`panel${person.accounts?.length ? " wide" : ""}`}
      aria-label={`Life of ${person.name}`}
    >
      <header>
        <div
          aria-hidden="true"
          style={{
            width: 8,
            alignSelf: "stretch",
            borderRadius: 4,
            background: branchColor(person.branch),
          }}
        />
        <div className="who">
          <h2>{person.name}</h2>
          {person.nee && <div className="nee">née {person.nee}</div>}
          <div className="nee" style={{ fontStyle: "normal" }}>
            {lifespan(person)}
          </div>
        </div>
        <button className="btn icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="body">
        <div className="chips">
          <span className="chip">
            {BRANCH_LABELS[person.branch ?? "other"] ?? "Other"}
          </span>
          {(person.tags ?? []).map((t) => (
            <span className="chip" key={t}>
              {t}
            </span>
          ))}
          {person.unverified && (
            <span className="chip warn">Needs a source</span>
          )}
        </div>

        <dl className="facts">
          {person.born && (
            <>
              <dt>Born</dt>
              <dd>
                {person.born}
                {person.bornPlace ? ` · ${person.bornPlace}` : ""}
              </dd>
            </>
          )}
          {person.died && (
            <>
              <dt>Died</dt>
              <dd>
                {person.died}
                {person.diedPlace ? ` · ${person.diedPlace}` : ""}
              </dd>
            </>
          )}
        </dl>

        <section className="block">
          <h4>
            Gallery
            <span className="count">
              {photos.length} of {MAX_PHOTOS}
            </span>
          </h4>
          <PhotoCarousel
            // A new person or a new main photo starts back at the front.
            key={`${person.id}|${primaryId ?? ""}`}
            personName={person.name}
            photos={photos}
            primaryId={primaryId}
            max={MAX_PHOTOS}
            onSetPrimary={onSetPrimary}
            onAdd={() => onContribute("photo")}
          />
          <p className="note">
            Up to five. A photograph goes up straight away with the family
            passcode, and stays: each one added uses up a spot for good. The
            main photo is the one shown on their card in the tree.
          </p>

        </section>

        <section className="block">
          <h4>Their life</h4>
          {pendingBio ? (
            <>
              <p className="blurb pending-text">{pendingBio}</p>
              <p className="note">
                Your version, waiting on approval. The record still reads as
                below.
              </p>
              {story && <p className="blurb muted">{story}</p>}
            </>
          ) : story ? (
            <>
              <p className="blurb">{story}</p>
              {liveStory && (
                <p className="note">
                  Written by the family
                  {liveStory.by ? ` — ${liveStory.by}` : ""}. Anyone can add to
                  it.
                </p>
              )}
            </>
          ) : (
            <p className="blurb muted">
              Nothing written down yet. If you knew them, you are the source.
            </p>
          )}
          <button className="btn wide" onClick={() => onContribute("biography")}>
            {story ? "Add to their story" : "Write their story"}
          </button>
        </section>

        <section className="block">
          <h4>Connected</h4>
          <div className="pills">
            {relatives.map((r) => {
              const note = noteFor(r.id);
              return (
                <button key={r.id} onClick={() => onGoTo(r.id)}>
                  {r.name}
                  {note && <em>{note}</em>}
                </button>
              );
            })}
            {pendingRelatives.map((r, i) => (
              <span className="pill-pending" key={`pr-${i}`}>
                {r.name}
                <em>{r.relationship} · pending</em>
              </span>
            ))}
          </div>
          <button className="btn wide" onClick={() => onContribute("relative")}>
            + Add a relative
          </button>
        </section>

        {person.accounts && person.accounts.length > 0 && (
          <section className="block">
            <h4>{person.question ?? "Competing accounts"}</h4>
            <div className="accounts">
              {person.accounts.map((a) => (
                <article className="account" key={a.title}>
                  <h5>{a.title}</h5>
                  <p className="account-source">{a.source}</p>
                  <p className="account-summary">{a.summary}</p>
                  <ul>
                    {a.points.map((pt, i) => (
                      <li key={i}>{pt}</li>
                    ))}
                  </ul>
                  {a.caveat && <p className="account-caveat">{a.caveat}</p>}
                </article>
              ))}
            </div>
            {person.wouldSettleIt && (
              <p className="settle">
                <strong>What would settle it.</strong> {person.wouldSettleIt}
              </p>
            )}
          </section>
        )}

        {person.links && person.links.length > 0 && (
          <section className="block">
            <h4>Where this comes from</h4>
            <div className="sources">
              {person.links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {l.label}
                </a>
              ))}
            </div>
          </section>
        )}

        <section className="block">
          <h4>Find a source</h4>
          <a
            className="btn wide"
            href={claudeResearch(person)}
            target="_blank"
            rel="noreferrer noopener"
          >
            Ask Claude to research them ↗
          </a>
          <div className="search-row">
            <a
              className="btn"
              href={webSearch(person)}
              target="_blank"
              rel="noreferrer noopener"
            >
              Google ↗
            </a>
            <a
              className="btn"
              href={troveSearch(
                person.name,
                person.diedPlace ?? person.bornPlace,
              )}
              target="_blank"
              rel="noreferrer noopener"
            >
              Trove newspapers ↗
            </a>
          </div>
          <p className="note">
            {historical
              ? "Claude opens with the question already written. Trove is the National Library's newspaper archive — free, and the best place for births, deaths, marriages and obituaries of this era."
              : "Claude opens with the question already written. Trove only holds newspapers up to the 1950s, so for someone this recent it will usually come back empty."}
          </p>
        </section>
      </div>
    </aside>
  );
}
