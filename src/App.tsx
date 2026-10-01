import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import treeData from "./data/tree.json";
import type { Contributor, Person, Photo, Proposal, TreeData } from "./types";
import { buildLayout, CARD_H, CARD_W, ROW_H, SIBLING_GAP } from "./lib/layout";
import {
  BRANCH_LABELS,
  LINE_BRANCHES,
  MARRIED_IN_BRANCHES,
  branchColor,
  lifespan,
  matches,
} from "./lib/person";
import TreeCanvas, {
  type Camera,
  type GhostCard,
} from "./components/TreeCanvas";
import PersonPanel, { type PendingRelative } from "./components/PersonPanel";
import ContributeModal, {
  type ContributeMode,
} from "./components/ContributeModal";
import { deletePhoto, fetchOverlay } from "./lib/api";
import type { LivePhoto, LiveStory } from "./lib/api";
import ConfirmDelete from "./components/ConfirmDelete";
import Splash from "./components/Splash";

const data = treeData as TreeData;

const RELATIONSHIP_WORDS: Record<string, string> = {
  child: "child",
  parent: "parent",
  partner: "partner",
  sibling: "sibling",
};

type Theme = "system" | "light" | "dark";

const THEME_KEY = "deguise-theme";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Private windows and blocked site data both land here; light is fine.
  }
  // The archive opens bright by default; the toggle offers dark and system.
  return "light";
}

const THEME_NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_LABEL: Record<Theme, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

const THEME_ICON: Record<Theme, string> = {
  system: "◐",
  light: "☀",
  dark: "☾",
};

/** Everything a visitor has contributed this session, before approval. */
interface Pending {
  photos: Photo[];
  bio?: string;
  relatives: PendingRelative[];
}

export default function App() {
  const layout = useMemo(() => buildLayout(data), []);
  const peopleById = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of data.people) m.set(p.id, p);
    return m;
  }, []);

  /** How a partnership ended, where the family has said so. */
  const partnerNotes = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of data.unions) {
      const note = u.final ? "last partner" : u.ended;
      if (!note) continue;
      for (const a of u.partners) {
        for (const b of u.partners) if (a !== b) m.set(`${a}|${b}`, note);
      }
    }
    return m;
  }, []);

  /** Partners already recorded for a person, straight from the unions. */
  const partnersOf = useCallback(
    (id: string) => {
      const out: Person[] = [];
      for (const u of data.unions) {
        if (!u.partners.includes(id)) continue;
        for (const other of u.partners) {
          if (other !== id) {
            const p = peopleById.get(other);
            if (p) out.push(p);
          }
        }
      }
      return out;
    },
    [peopleById],
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [branchFilter, setBranchFilter] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    mode: ContributeMode;
    person: Person | null;
  } | null>(null);
  const [contributor, setContributor] = useState<Contributor>({
    name: "",
    email: "",
  });
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [legendOpen, setLegendOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  /** Photographs published since the last deploy, keyed by person. */
  const [live, setLive] = useState<Record<string, LivePhoto[]>>({});
  /** The photograph the viewer has asked to remove, pending confirmation. */
  const [removing, setRemoving] = useState<LivePhoto | null>(null);
  /** Life stories published since the last deploy, keyed by person. */
  const [stories, setStories] = useState<Record<string, LiveStory>>({});
  const animation = useRef<number | null>(null);

  const refreshGallery = useCallback(async () => {
    const overlay = await fetchOverlay();
    const byPerson: Record<string, LivePhoto[]> = {};
    for (const r of overlay.photos) (byPerson[r.personId] ??= []).push(r);
    setLive(byPerson);
    setStories(
      Object.fromEntries(overlay.stories.map((s) => [s.personId, s])),
    );
  }, []);

  /** What a person's life reads as now — the family's version wins. */
  const storyFor = useCallback(
    (p: Person) => stories[p.id]?.text ?? p.blurb,
    [stories],
  );

  useEffect(() => {
    void refreshGallery();
  }, [refreshGallery]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
  }, [theme]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(
    (w = size.w, h = size.h) => {
      const b = layout.bounds;
      const pad = w < 700 ? 24 : 70;
      const treeW = Math.max(1, b.maxX - b.minX);
      const treeH = Math.max(1, b.maxY - b.minY);
      // On a narrow phone, fitting the full width makes the names unreadable.
      // Below this floor we stop shrinking and let people pan instead.
      const floor = w < 700 ? 0.42 : 0.02;
      const k = Math.max(
        floor,
        Math.min((w - pad * 2) / treeW, (h - pad * 2) / treeH, 1.1),
      );
      const scaledH = treeH * k;
      setCamera({
        k,
        x: w / 2 - ((b.minX + b.maxX) / 2) * k,
        y:
          scaledH + pad * 2 > h
            ? pad - b.minY * k
            : h / 2 - ((b.minY + b.maxY) / 2) * k,
      });
    },
    [layout.bounds, size.w, size.h],
  );

  // Keep the tree fitted to the viewport until the visitor takes the wheel.
  const userMoved = useRef(false);
  useEffect(() => {
    if (size.w > 10 && size.h > 10 && !userMoved.current) fit(size.w, size.h);
  }, [fit, size.w, size.h]);

  const handleCamera = useCallback(
    (next: Camera | ((c: Camera) => Camera)) => {
      userMoved.current = true;
      setCamera(next);
    },
    [],
  );

  const animateTo = useCallback((target: Camera) => {
    if (animation.current) cancelAnimationFrame(animation.current);
    const start = performance.now();
    let from: Camera | null = null;
    const step = (now: number) => {
      setCamera((current) => {
        from ??= current;
        const t = Math.min(1, (now - start) / 420);
        const e = 1 - Math.pow(1 - t, 3);
        return {
          x: from!.x + (target.x - from!.x) * e,
          y: from!.y + (target.y - from!.y) * e,
          k: from!.k + (target.k - from!.k) * e,
        };
      });
      if (now - start < 420) animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
  }, []);

  const flyTo = useCallback(
    (id: string) => {
      const p = layout.placed.get(id);
      if (!p) return;
      const k = Math.max(camera.k, 0.85);
      animateTo({ k, x: size.w / 2 - p.cx * k, y: size.h / 2 - p.cy * k });
      setSelectedId(id);
      userMoved.current = true;
    },
    [animateTo, camera.k, layout.placed, size.h, size.w],
  );

  /** Frame a set of people — used when a family is picked from the legend. */
  const fitToIds = useCallback(
    (ids: Set<string>) => {
      const pts = [...ids]
        .map((id) => layout.placed.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      if (!pts.length || size.w < 10) return;
      const b = pts.reduce(
        (a, p) => ({
          minX: Math.min(a.minX, p.x),
          minY: Math.min(a.minY, p.y),
          maxX: Math.max(a.maxX, p.x + CARD_W),
          maxY: Math.max(a.maxY, p.y + CARD_H),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      const pad = 90;
      const k = Math.max(
        0.02,
        Math.min(
          (size.w - pad * 2) / Math.max(1, b.maxX - b.minX),
          (size.h - pad * 2) / Math.max(1, b.maxY - b.minY),
          1.0,
        ),
      );
      userMoved.current = true;
      animateTo({
        k,
        x: size.w / 2 - ((b.minX + b.maxX) / 2) * k,
        y: size.h / 2 - ((b.minY + b.maxY) / 2) * k,
      });
    },
    [animateTo, layout.placed, size.w, size.h],
  );

  const pickBranch = (b: string | null) => {
    setBranchFilter(b);
    setSelectedId(null);
    if (b) {
      fitToIds(
        new Set(
          data.people
            .filter((p) => (p.branch ?? "other") === b)
            .map((p) => p.id),
        ),
      );
    } else {
      userMoved.current = false;
      fit();
    }
  };

  const zoomBy = (factor: number) => {
    userMoved.current = true;
    setCamera((c) => {
      const k = Math.min(2.6, Math.max(0.02, c.k * factor));
      const ratio = k / c.k;
      return {
        k,
        x: size.w / 2 - (size.w / 2 - c.x) * ratio,
        y: size.h / 2 - (size.h / 2 - c.y) * ratio,
      };
    });
  };

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return data.people.filter((p) => matches(p, query)).slice(0, 40);
  }, [query]);

  const highlightIds = useMemo(() => {
    const q = query.trim();
    if (!q && !branchFilter) return null;
    let ids = q ? results.map((p) => p.id) : data.people.map((p) => p.id);
    if (branchFilter) {
      const inBranch = new Set(
        data.people
          .filter((p) => (p.branch ?? "other") === branchFilter)
          .map((p) => p.id),
      );
      ids = ids.filter((id) => inBranch.has(id));
    }
    return new Set(ids);
  }, [query, results, branchFilter]);

  const selected = selectedId ? peopleById.get(selectedId) ?? null : null;
  const hovered = hoveredId ? peopleById.get(hoveredId) ?? null : null;

  const relativesOf = (id: string) =>
    [...(layout.relatives.get(id) ?? [])]
      .map((rid) => peopleById.get(rid))
      .filter((p): p is Person => Boolean(p));

  /** Show a contribution on the page straight away, marked as pending. */
  const applyProposal = (
    proposal: Proposal,
    _file?: File,
    previewUrl?: string,
    live?: boolean,
  ) => {
    setPending((prev) => {
      const cur: Pending = prev[proposal.personId] ?? {
        photos: [],
        relatives: [],
      };
      const next: Pending = { ...cur };
      if (proposal.kind === "photo" && previewUrl) {
        next.photos = [
          ...cur.photos,
          { src: previewUrl, caption: proposal.caption },
        ];
        // It is already on the CDN; pick up the published copy shortly and
        // drop this local preview so nobody sees it twice.
        window.setTimeout(() => {
          void refreshGallery();
          setPending((p2) => ({
            ...p2,
            [proposal.personId]: { ...(p2[proposal.personId] ?? { photos: [], relatives: [] }), photos: [] },
          }));
        }, 1800);
      } else if (proposal.kind === "biography") {
        if (live) {
          // Published. Show it as the record rather than as something pending,
          // and let the re-read replace this optimistic copy.
          setStories((s) => ({
            ...s,
            [proposal.personId]: {
              id: "local",
              personId: proposal.personId,
              text: proposal.text,
            },
          }));
          window.setTimeout(() => void refreshGallery(), 1800);
        } else {
          next.bio = proposal.text;
        }
      } else if (proposal.kind === "relative") {
        next.relatives = [
          ...cur.relatives,
          {
            name: proposal.newPerson.name,
            relationship:
              RELATIONSHIP_WORDS[proposal.relationship] ??
              proposal.relationship,
          },
        ];
      }
      return { ...prev, [proposal.personId]: next };
    });
  };

  const pendingFor = (id: string): Pending =>
    pending[id] ?? { photos: [], relatives: [] };

  /**
   * Proposed people, placed next to whoever they were attached to. They are
   * positioned rather than laid out: re-running the layout engine would shift
   * the whole tree around a suggestion nobody has agreed to yet.
   */
  const ghosts = useMemo<GhostCard[]>(() => {
    const out: GhostCard[] = [];
    for (const [anchorId, entry] of Object.entries(pending)) {
      const at = layout.placed.get(anchorId);
      if (!at || !entry.relatives.length) continue;
      entry.relatives.forEach((rel, i) => {
        const step = i * (CARD_W + SIBLING_GAP);
        let x = at.x;
        let y = at.y;
        if (rel.relationship === "child") {
          x = at.x + step;
          y = at.y + ROW_H;
        } else if (rel.relationship === "parent") {
          x = at.x + step;
          y = at.y - ROW_H;
        } else {
          // A partner or sibling sits alongside, clear of the card itself.
          x = at.x + CARD_W + SIBLING_GAP + step;
          y = at.y;
        }
        out.push({
          key: `${anchorId}-${i}`,
          x,
          y,
          fromX: at.x + CARD_W / 2,
          fromY: at.y + CARD_H / 2,
          name: rel.name,
          relationship: rel.relationship,
        });
      });
    }
    return out;
  }, [pending, layout.placed]);

  // Position the hover card beside the card it belongs to.
  const hoverPos = (() => {
    if (!hoveredId) return null;
    const p = layout.placed.get(hoveredId);
    if (!p) return null;
    const w = 260;
    let x = camera.x + (p.x + CARD_W + 12) * camera.k;
    let y = camera.y + p.y * camera.k;
    if (x + w > size.w - 12) x = camera.x + (p.x - 12) * camera.k - w;
    x = Math.max(12, Math.min(x, size.w - w - 12));
    y = Math.max(12, Math.min(y, size.h - 220));
    return { x, y };
  })();

  /** How many people carry each family line, for the legend. */
  const branchCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.people) {
      const b = p.branch ?? "other";
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  }, []);

  const present = (list: readonly string[]) =>
    list.filter((b) => (branchCounts.get(b) ?? 0) > 0);

  const familyButton = (b: string) => (
    <button
      key={b}
      className={branchFilter === b ? "on" : undefined}
      aria-pressed={branchFilter === b}
      onClick={() => pickBranch(branchFilter === b ? null : b)}
    >
      <i style={{ background: branchColor(b) }} />
      {BRANCH_LABELS[b] ?? b}
      <em>{branchCounts.get(b)}</em>
    </button>
  );

  return (
    <div className="app">
      {splash && (
        <Splash
          title={data.title}
          subtitle={data.subtitle}
          onDone={() => setSplash(false)}
        />
      )}
      <div className="topbar">
        <div className="brand">
          <h1>{data.title}</h1>
          <span>
            {data.subtitle} · {data.people.length} people
          </span>
        </div>

        <div className="search sans">
          <span className="glass" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            value={query}
            placeholder="Search a name, year or place…"
            aria-label="Search the tree"
            onChange={(e) => {
              setQuery(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            onBlur={() => window.setTimeout(() => setShowResults(false), 160)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) {
                flyTo(results[0].id);
                setShowResults(false);
              }
            }}
          />
          {query && (
            <button
              className="clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              ✕
            </button>
          )}
          {showResults && query.trim() && (
            <ul className="results">
              {results.length === 0 && (
                <li className="empty">No one by that name yet.</li>
              )}
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      flyTo(p.id);
                      setShowResults(false);
                    }}
                  >
                    <span>{p.name}</span>
                    <span className="dates">{lifespan(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="spacer" />

        <button
          className="btn icon sans"
          onClick={() => setTheme(THEME_NEXT[theme])}
          title={`Theme: ${THEME_LABEL[theme]}`}
          aria-label={`Theme: ${THEME_LABEL[theme]}. Click to change.`}
        >
          {THEME_ICON[theme]}
        </button>
        <button
          className="btn sans"
          onClick={() => {
            userMoved.current = false;
            fit();
          }}
        >
          Fit tree
        </button>
        <button
          className="btn primary sans"
          onClick={() => setModal({ mode: "relative", person: selected })}
        >
          + Add a person
        </button>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <TreeCanvas
          layout={layout}
          camera={camera}
          onCamera={handleCamera}
          selectedId={selectedId}
          hoveredId={hoveredId}
          highlightIds={highlightIds}
          onHover={setHoveredId}
          onSelect={setSelectedId}
          ghosts={ghosts}
          stageRef={stageRef}
        />

        {hovered && hoverPos && hovered.id !== selectedId && (
          <div
            className="hovercard"
            style={{ left: hoverPos.x, top: hoverPos.y }}
          >
            <h3>{hovered.name}</h3>
            <div className="dates">
              {[lifespan(hovered), BRANCH_LABELS[hovered.branch ?? "other"]]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="thumbs">
              {[
                ...(hovered.photos ?? []),
                ...(live[hovered.id] ?? []).map((p) => ({
                  src: p.src,
                  caption: p.caption,
                })),
                ...pendingFor(hovered.id).photos,
              ]
                .slice(0, 5)
                .map((ph, i) => (
                  <img className="thumb" key={i} src={ph.src} alt="" />
                ))}
              {(hovered.photos ?? []).length +
                (live[hovered.id] ?? []).length +
                pendingFor(hovered.id).photos.length ===
                0 &&
                Array.from({ length: 5 }).map((_, i) => (
                  <div className="thumb" key={i} />
                ))}
            </div>
            {(pendingFor(hovered.id).bio ?? storyFor(hovered)) && (
              <p>
                {(() => {
                  const t = pendingFor(hovered.id).bio ?? storyFor(hovered) ?? "";
                  return t.length > 165 ? `${t.slice(0, 164)}…` : t;
                })()}
              </p>
            )}
            <div className="hint">Click to open, add photos and stories</div>
          </div>
        )}

        {selected && (
          <PersonPanel
            person={selected}
            relatives={relativesOf(selected.id)}
            noteFor={(otherId) =>
              partnerNotes.get(`${selected.id}|${otherId}`)
            }
            livePhotos={live[selected.id] ?? []}
            onDeletePhoto={setRemoving}
            liveStory={stories[selected.id]}
            pendingPhotos={pendingFor(selected.id).photos}
            pendingBio={pendingFor(selected.id).bio}
            pendingRelatives={pendingFor(selected.id).relatives}
            onClose={() => setSelectedId(null)}
            onGoTo={flyTo}
            onContribute={(mode) => setModal({ mode, person: selected })}
          />
        )}

        <div className={`legend sans${legendOpen ? " open" : ""}`}>
          <button
            className="legend-head"
            onClick={() => setLegendOpen((v) => !v)}
            aria-expanded={legendOpen}
          >
            <span>Families</span>
            {branchFilter && (
              <span className="legend-active">
                <i style={{ background: branchColor(branchFilter) }} />
                {BRANCH_LABELS[branchFilter]}
              </span>
            )}
            <span className="chev" aria-hidden="true">
              {legendOpen ? "▾" : "▴"}
            </span>
          </button>

          {legendOpen && (
            <div className="legend-body">
              <div className="legend-group">
                <h5>The line it descends along</h5>
                <div className="legend-items">
                  {present(LINE_BRANCHES).map(familyButton)}
                </div>
              </div>
              <div className="legend-group">
                <h5>Married in, with descendants here</h5>
                <div className="legend-items">
                  {present(MARRIED_IN_BRANCHES).map(familyButton)}
                </div>
              </div>
              <div className="legend-items">
                {present(["other"]).map(familyButton)}
                {branchFilter && (
                  <button className="reset" onClick={() => pickBranch(null)}>
                    Show all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="zoomers sans">
          <button
            className="btn icon"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="btn icon"
            onClick={() => zoomBy(0.8)}
            aria-label="Zoom out"
          >
            −
          </button>
        </div>
      </div>

      {removing && (
        <ConfirmDelete
          photo={removing}
          personName={peopleById.get(removing.personId)?.name ?? "this person"}
          onCancel={() => setRemoving(null)}
          onConfirm={async (passcode) => {
            await deletePhoto(removing.id, passcode);
            // Drop it locally at once so the gallery does not show a picture
            // that no longer exists, then re-read to stay in step with S3.
            setLive((prev) => ({
              ...prev,
              [removing.personId]: (prev[removing.personId] ?? []).filter(
                (p) => p.id !== removing.id,
              ),
            }));
            setRemoving(null);
            window.setTimeout(() => void refreshGallery(), 1500);
          }}
        />
      )}

      {modal && (
        <ContributeModal
          mode={modal.mode}
          person={modal.person}
          people={data.people}
          partnersOf={partnersOf}
          currentStory={modal.person ? storyFor(modal.person) : undefined}
          contributor={contributor}
          onContributor={setContributor}
          onDone={applyProposal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
