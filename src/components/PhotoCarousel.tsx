import { useRef, useState } from "react";
import { readPasscode, rememberPasscode, SubmitError } from "../lib/api";

export interface CarouselPhoto {
  /** A live photo's id, or the src of a photograph in the record. */
  id: string;
  src: string;
  caption?: string;
  /** Uploaded from this browser a moment ago; not yet in the gallery. */
  justAdded?: boolean;
}

interface Props {
  personName: string;
  photos: CarouselPhoto[];
  /** The family's chosen main photo. Falls back to the first. */
  primaryId?: string;
  max: number;
  onSetPrimary: (photoId: string, passcode: string) => Promise<void>;
  onAdd?: () => void;
}

/**
 * A person's photographs, main photo first. Swipe or use the arrows to look
 * through them; anyone with the family passcode can make one the main photo,
 * which is the one shown on their card in the tree. Photographs cannot be
 * removed from here — once added, they stay.
 */
export default function PhotoCarousel({
  personName,
  photos,
  primaryId,
  max,
  onSetPrimary,
  onAdd,
}: Props) {
  const mainId =
    primaryId && photos.some((p) => p.id === primaryId) ? primaryId : photos[0]?.id;
  const ordered = [
    ...photos.filter((p) => p.id === mainId),
    ...photos.filter((p) => p.id !== mainId),
  ];

  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askPass, setAskPass] = useState(false);
  const [pass, setPass] = useState("");
  const swipe = useRef<number | null>(null);

  const canAdd = Boolean(onAdd) && photos.length < max;

  if (ordered.length === 0) {
    return canAdd ? (
      <button className="addslot pc-first" onClick={onAdd}>
        <span className="plus" aria-hidden="true">+</span>
        Add the first photograph of {personName}
      </button>
    ) : null;
  }

  const i = Math.min(index, ordered.length - 1);
  const current = ordered[i];
  const isMain = current.id === mainId;
  const go = (d: number) => setIndex((n) => (n + d + ordered.length) % ordered.length);

  async function makeMain(passcode: string) {
    setSaving(true);
    setError(null);
    try {
      await onSetPrimary(current.id, passcode);
      rememberPasscode(passcode);
      setAskPass(false);
    } catch (e) {
      if (e instanceof SubmitError && /passcode/i.test(e.message)) setAskPass(true);
      setError(e instanceof Error ? e.message : "Could not save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pc">
      <div
        className="pc-stage"
        onTouchStart={(e) => (swipe.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (swipe.current === null) return;
          const dx = e.changedTouches[0].clientX - swipe.current;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          swipe.current = null;
        }}
      >
        <img src={current.src} alt={current.caption ?? personName} />
        {isMain && <span className="pc-tag">Main photo</span>}
        {current.justAdded && <span className="pc-tag pc-new">Just added</span>}
        {ordered.length > 1 && (
          <>
            <button className="pc-arrow pc-prev" onClick={() => go(-1)} aria-label="Previous photograph">‹</button>
            <button className="pc-arrow pc-next" onClick={() => go(1)} aria-label="Next photograph">›</button>
          </>
        )}
      </div>
      {current.caption && <p className="pc-caption">{current.caption}</p>}

      <div className="pc-strip" role="tablist" aria-label={`Photographs of ${personName}`}>
        {ordered.map((p, n) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={n === i}
            aria-label={p.id === mainId ? "Main photo" : `Photo ${n + 1}`}
            className={`pc-thumb${n === i ? " on" : ""}${p.id === mainId ? " main" : ""}`}
            onClick={() => setIndex(n)}
          >
            <img src={p.src} alt="" loading="lazy" />
          </button>
        ))}
        {canAdd && (
          <button className="pc-thumb pc-add" onClick={onAdd} aria-label={`Add a photograph of ${personName}`}>
            +
          </button>
        )}
      </div>

      {!isMain && !current.justAdded && !askPass && (
        <button
          className="btn wide"
          disabled={saving}
          onClick={() => {
            const stored = readPasscode();
            if (stored) void makeMain(stored);
            else setAskPass(true);
          }}
        >
          {saving ? "Saving…" : "Make this the main photo"}
        </button>
      )}

      {askPass && (
        <form
          className="pc-pass"
          onSubmit={(e) => {
            e.preventDefault();
            if (pass.trim()) void makeMain(pass.trim());
          }}
        >
          <input
            type="password"
            value={pass}
            autoComplete="current-password"
            placeholder="Family passcode"
            aria-label="Family passcode"
            onChange={(e) => setPass(e.target.value)}
          />
          <button className="btn primary" disabled={saving || !pass.trim()}>
            {saving ? "Saving…" : "Make main photo"}
          </button>
        </form>
      )}
      {error && <p className="note pc-error" role="alert">{error}</p>}
    </div>
  );
}
