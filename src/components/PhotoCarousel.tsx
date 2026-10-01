// Photo carousel for a person's panel.
//
// The main photo shows first and wears a "Main photo" tag. Swipe or use the
// arrows to look through the rest; "Make this the main photo" sets it for
// everyone. There is no remove button: photos are permanent once added.
//
// Props come from the merged record + gallery.json:
//   photos    all photos for the person, record first then live
//   primaryId gallery.primary[person.id] ?? photos[0]?.id
//   onSetPrimary(photoId) POSTs { action: "setPrimary", personId, photoId,
//             passcode } to the Lambda and resolves when done.
//   onAdd     opens the existing upload flow (hidden when all 5 are used)

import { useEffect, useRef, useState } from "react";

export interface Photo { id: string; src: string; caption?: string }

const MAX = 5;

export default function PhotoCarousel({
  photos, primaryId, onSetPrimary, onAdd,
}: {
  photos: Photo[];
  primaryId?: string;
  onSetPrimary: (photoId: string) => Promise<void>;
  onAdd?: () => void;
}) {
  // Main photo first, the rest in their original order.
  const ordered = [...photos].sort(
    (a, b) => Number(b.id === primaryId) - Number(a.id === primaryId));

  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touchX = useRef<number | null>(null);

  useEffect(() => { setIndex(0); }, [primaryId, photos.length]);

  if (ordered.length === 0) {
    return onAdd ? (
      <button className="pc-empty" onClick={onAdd}>Add the first photo</button>
    ) : null;
  }

  const current = ordered[Math.min(index, ordered.length - 1)];
  const isMain = current.id === primaryId || (!primaryId && index === 0);
  const go = (d: number) =>
    setIndex((i) => (i + d + ordered.length) % ordered.length);

  async function makeMain() {
    setSaving(true); setError(null);
    try { await onSetPrimary(current.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save. Try again."); }
    finally { setSaving(false); }
  }

  return (
    <div className="pc">
      <div
        className="pc-stage"
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
      >
        <img src={current.src} alt={current.caption ?? ""} />
        {isMain && <span className="pc-tag">Main photo</span>}
        {ordered.length > 1 && (
          <>
            <button className="pc-arrow pc-prev" aria-label="Previous photo" onClick={() => go(-1)}>‹</button>
            <button className="pc-arrow pc-next" aria-label="Next photo" onClick={() => go(1)}>›</button>
          </>
        )}
      </div>

      {current.caption && <p className="pc-caption">{current.caption}</p>}

      <div className="pc-thumbs" role="tablist">
        {ordered.map((p, i) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={i === index}
            className={`pc-thumb${i === index ? " is-current" : ""}${p.id === primaryId ? " is-main" : ""}`}
            onClick={() => setIndex(i)}
          >
            <img src={p.src} alt="" />
          </button>
        ))}
        {onAdd && ordered.length < MAX && (
          <button className="pc-thumb pc-add" onClick={onAdd} aria-label="Add a photo">+</button>
        )}
      </div>

      <div className="pc-foot">
        {!isMain && (
          <button className="pc-main" onClick={makeMain} disabled={saving}>
            {saving ? "Saving…" : "Make this the main photo"}
          </button>
        )}
        <span className="pc-count">{ordered.length} of {MAX} photos used</span>
      </div>
      {error && <p className="pc-error" role="alert">{error}</p>}
    </div>
  );
}

/* Styles to add to the stylesheet:

.pc { display:grid; gap:.6rem }
.pc-stage { position:relative; aspect-ratio:4/3; background:#e9ebe6; border-radius:8px;
            overflow:hidden; touch-action:pan-y }
.pc-stage img { width:100%; height:100%; object-fit:contain }
.pc-tag { position:absolute; left:.6rem; top:.6rem; background:#2f5d3a; color:#fff;
          font-size:.8rem; padding:.2rem .55rem; border-radius:4px }
.pc-arrow { position:absolute; top:50%; translate:0 -50%; width:2.4rem; height:2.4rem;
            border:0; border-radius:50%; background:rgba(255,255,255,.85); font-size:1.4rem }
.pc-prev { left:.5rem } .pc-next { right:.5rem }
.pc-thumbs { display:flex; gap:.4rem; overflow-x:auto }
.pc-thumb { flex:0 0 3.5rem; height:3.5rem; padding:0; border:2px solid transparent;
            border-radius:6px; overflow:hidden; background:#e9ebe6 }
.pc-thumb img { width:100%; height:100%; object-fit:cover }
.pc-thumb.is-current { border-color:#1f2a24 }
.pc-thumb.is-main { box-shadow:inset 0 -4px 0 #2f5d3a }
.pc-add { font-size:1.5rem; color:#5d665f }
.pc-foot { display:flex; align-items:center; justify-content:space-between; gap:.75rem }
.pc-main { border:1px solid #2f5d3a; color:#2f5d3a; background:none; border-radius:6px;
           padding:.45rem .8rem }
.pc-count { color:#5d665f; font-size:.85rem; margin-left:auto }
.pc-error { color:#a33; margin:0 }
*/
