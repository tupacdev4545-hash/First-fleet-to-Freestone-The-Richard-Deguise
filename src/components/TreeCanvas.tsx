import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Layout } from "../lib/layout";
import { CARD_H, CARD_W } from "../lib/layout";
import { branchColor, initials, lifespan, wrap } from "../lib/person";

export interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Props {
  layout: Layout;
  camera: Camera;
  onCamera: (next: Camera | ((c: Camera) => Camera)) => void;
  selectedId: string | null;
  hoveredId: string | null;
  highlightIds: Set<string> | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  /** People proposed this session, awaiting the archivist. */
  ghosts: GhostCard[];
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** The person's main photograph, shown in place of their initials. */
  mainPhoto?: (id: string) => string | undefined;
}

const MIN_K = 0.02;
const MAX_K = 2.6;

/**
 * Someone a visitor has proposed. It is drawn on the tree straight away so the
 * suggestion is visible in place rather than buried in a panel — but drawn as
 * an outline, never as a member of the family, until the archivist confirms it.
 */
export interface GhostCard {
  key: string;
  x: number;
  y: number;
  /** Where the line comes from, so the tie to the anchor is obvious. */
  fromX: number;
  fromY: number;
  name: string;
  relationship: string;
}

type Lod = "blocks" | "compact" | "full";

interface TextRow {
  text: string;
  cls: "name" | "meta" | "flag";
}

/** Stack the card's text rows and centre them vertically in the card. */
function layoutRows(rows: TextRow[]) {
  const h = (r: TextRow) => (r.cls === "name" ? 21 : 17);
  const total = rows.reduce((a, r) => a + h(r), 0);
  let y = (CARD_H - total) / 2;
  return rows.map((r) => {
    y += h(r);
    return { ...r, y: y - 3 };
  });
}

export default function TreeCanvas({
  layout,
  camera,
  onCamera,
  selectedId,
  hoveredId,
  highlightIds,
  onHover,
  onSelect,
  ghosts,
  stageRef,
  mainPhoto,
}: Props) {
  /** Survives pointerup so the click handler can tell a drag from a tap. */
  const moved = useRef(false);
  /**
   * Every finger currently down, in stage coordinates. The stage sets
   * `touch-action: none`, which tells the browser we handle pinching.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /**
   * The camera, finger midpoint and finger span when the current gesture (or
   * the current number of fingers) began. Every frame is worked out from this,
   * not from the frame before, so small errors cannot pile up into drift.
   */
  const start = useRef<{ cam: Camera; mid: { x: number; y: number }; dist: number } | null>(null);
  const downAt = useRef<{ x: number; y: number; t: number } | null>(null);
  const captured = useRef(false);
  /** For double-tap to zoom, which is how most people zoom one-handed. */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const cameraRef = useRef(camera);
  useLayoutEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  /** Pointer position relative to the stage, which is what the camera uses. */
  const local = useCallback(
    (x: number, y: number) => {
      const r = stageRef.current?.getBoundingClientRect();
      return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
    },
    [stageRef],
  );

  /** Scale about a fixed point, so whatever is under the fingers stays put. */
  const zoomAbout = useCallback(
    (factor: number, px: number, py: number) => {
      onCamera((c) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, c.k * factor));
        const ratio = k / c.k;
        return { k, x: px - (px - c.x) * ratio, y: py - (py - c.y) * ratio };
      });
    },
    [onCamera],
  );

  /** Start measuring afresh from where the fingers are now. */
  const rebaseline = () => {
    const pts = [...pointers.current.values()];
    if (!pts.length) {
      start.current = null;
      return;
    }
    const [a, b] = pts;
    start.current = {
      cam: { ...cameraRef.current },
      mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
    };
  };

  /**
   * Hold on to the fingers once a gesture is under way. Without this, zooming
   * swaps the card drawings (see level of detail below), the element a finger
   * landed on is deleted, and on iPhone that finger's "lifted" event never
   * reaches the stage. The tree then believed a finger was still down, and the
   * next touch pinched against that phantom point — the sudden zoom-outs.
   * Not done on touch-down, because capturing then would steal the click from
   * the person card underneath.
   */
  const capture = () => {
    if (captured.current) return;
    captured.current = true;
    for (const id of pointers.current.keys()) {
      try {
        stageRef.current?.setPointerCapture(id);
      } catch {
        // That pointer has already gone.
      }
    }
  };

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const el = stageRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      onCamera((c) => {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
        const k = Math.min(MAX_K, Math.max(MIN_K, c.k * factor));
        const ratio = k / c.k;
        return { k, x: px - (px - c.x) * ratio, y: py - (py - c.y) * ratio };
      });
    },
    [onCamera, stageRef],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // Safari's own pinch events, which would otherwise zoom the whole page.
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stopGesture);
    el.addEventListener("gesturechange", stopGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stopGesture);
      el.removeEventListener("gesturechange", stopGesture);
    };
  }, [onWheel, stageRef]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // The first finger of a new touch. Anything still listed is a finger whose
    // "lifted" event went missing — forget it rather than pinch against it.
    if (e.isPrimary) {
      pointers.current.clear();
      captured.current = false;
    }
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 1) {
      moved.current = false;
      downAt.current = { ...p, t: performance.now() };
      stageRef.current?.classList.add("dragging");
    } else {
      // A second finger turns a drag into a pinch.
      moved.current = true;
      capture();
    }
    rebaseline();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
    const s0 = start.current;
    if (!s0) return;

    const pts = [...pointers.current.values()];
    if (!moved.current) {
      const d = downAt.current;
      if (d && Math.hypot(pts[0].x - d.x, pts[0].y - d.y) <= 4) return;
      moved.current = true;
      capture();
    }

    if (pts.length === 1) {
      onCamera({
        ...s0.cam,
        x: s0.cam.x + pts[0].x - s0.mid.x,
        y: s0.cam.y + pts[0].y - s0.mid.y,
      });
      return;
    }

    // Two fingers: scale by the span against where it started, and keep the
    // spot that was under the fingers under them, so pinching and dragging
    // work in the same motion.
    if (s0.dist < 12) {
      rebaseline();
      return;
    }
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const k = Math.min(MAX_K, Math.max(MIN_K, s0.cam.k * (dist / s0.dist)));
    const wx = (s0.mid.x - s0.cam.x) / s0.cam.k;
    const wy = (s0.mid.y - s0.cam.y) / s0.cam.k;
    onCamera({ k, x: mid.x - wx * k, y: mid.y - wy * k });
  };

  const release = (e: React.PointerEvent, tapAllowed: boolean) => {
    if (!pointers.current.delete(e.pointerId)) return;

    if (pointers.current.size === 0) {
      captured.current = false;
      stageRef.current?.classList.remove("dragging");

      // Double tap zooms in on the spot touched. Judged on lift, so the first
      // finger of a quick second pinch is never mistaken for a tap.
      const d = downAt.current;
      const now = performance.now();
      if (tapAllowed && !moved.current && e.pointerType !== "mouse" && d && now - d.t < 300) {
        const prev = lastTap.current;
        if (prev && now - prev.t < 350 && Math.hypot(d.x - prev.x, d.y - prev.y) < 34) {
          zoomAbout(1.9, d.x, d.y);
          moved.current = true;
          lastTap.current = null;
        } else {
          lastTap.current = { t: now, x: d.x, y: d.y };
        }
      } else {
        lastTap.current = null;
      }
    }
    // Lifting one finger of a pinch hands control to the one still down,
    // measured from here, so the tree does not jump.
    rebaseline();
  };

  // Level of detail. Names are unreadable much below half scale, and 220 sets
  // of text nodes are wasted paint at that size — so far out the tree is drawn
  // as coloured blocks, and the shape of the family is the picture.
  const lod: Lod =
    camera.k < 0.3 ? "blocks" : camera.k < 0.62 ? "compact" : "full";

  const cards = useMemo(
    () =>
      layout.order.map(({ person, x, y }) => {
        const dates = lifespan(person);
        const full = layoutRows([
          ...wrap(person.name, 22, 2).map((t) => ({
            text: t,
            cls: "name" as const,
          })),
          ...(person.nee
            ? [{ text: `née ${person.nee}`, cls: "meta" as const }]
            : []),
          ...(dates ? [{ text: dates, cls: "meta" as const }] : []),
          ...(person.photos?.length
            ? [
                {
                  text: `${person.photos.length} photo${
                    person.photos.length > 1 ? "s" : ""
                  }`,
                  cls: "flag" as const,
                },
              ]
            : []),
        ]);
        const compact = layoutRows([
          ...wrap(person.name, 30, 2).map((t) => ({
            text: t,
            cls: "name" as const,
          })),
          ...(dates ? [{ text: dates, cls: "meta" as const }] : []),
        ]);
        return { person, x, y, full, compact };
      }),
    [layout.order],
  );

  return (
    <div
      className="stage"
      ref={stageRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => release(e, true)}
      onPointerCancel={(e) => release(e, false)}
      onLostPointerCapture={(e) => release(e, false)}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") release(e, false);
      }}
    >
      <svg role="presentation">
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.k})`}>
          <g className="links">
            {layout.links.map((l) => (
              <path
                key={l.id}
                d={l.d}
                vectorEffect="non-scaling-stroke"
                className={`link ${l.kind}${
                  highlightIds !== null ? " dim" : ""
                }`}
              />
            ))}
          </g>
          <g className="nodes">
            {cards.map(({ person, x, y, full, compact }) => {
              const active =
                person.id === selectedId || person.id === hoveredId;
              const dim = highlightIds !== null && !highlightIds.has(person.id);
              const colour = branchColor(person.branch);
              const rows = lod === "full" ? full : compact;
              const textX = lod === "full" ? 74 : 18;

              return (
                <g
                  key={person.id}
                  className={`node${active ? " active" : ""}${
                    dim ? " dim" : ""
                  }`}
                  transform={`translate(${x} ${y})`}
                  onPointerEnter={() => onHover(person.id)}
                  onPointerLeave={() => onHover(null)}
                  onClick={() => {
                    if (!moved.current) onSelect(person.id);
                  }}
                >
                  {lod === "blocks" ? (
                    <rect
                      width={CARD_W}
                      height={CARD_H}
                      rx={10}
                      fill={colour}
                      opacity={active ? 1 : 0.6}
                      stroke={active ? "var(--ring)" : "none"}
                      strokeWidth={active ? 10 : 0}
                    />
                  ) : (
                    <>
                      <rect
                        className="plate"
                        width={CARD_W}
                        height={CARD_H}
                        rx={10}
                      />
                      <rect
                        width={4}
                        height={CARD_H - 24}
                        x={0.5}
                        y={10}
                        rx={2}
                        fill={colour}
                      />
                      {lod === "full" && (
                        <>
                          <circle
                            className="avatar-ring"
                            cx={38}
                            cy={CARD_H / 2}
                            r={23}
                            stroke={colour}
                          />
                          {(() => {
                            const src = mainPhoto?.(person.id);
                            if (!src) {
                              return (
                                <text
                                  className="initials"
                                  x={38}
                                  y={CARD_H / 2 + 1}
                                  fill={colour}
                                >
                                  {initials(person.name)}
                                </text>
                              );
                            }
                            const clip = `av-${person.id.replace(/[^\w-]/g, "_")}`;
                            return (
                              <>
                                <clipPath id={clip}>
                                  <circle cx={38} cy={CARD_H / 2} r={22} />
                                </clipPath>
                                <image
                                  href={src}
                                  x={16}
                                  y={CARD_H / 2 - 22}
                                  width={44}
                                  height={44}
                                  preserveAspectRatio="xMidYMid slice"
                                  clipPath={`url(#${clip})`}
                                />
                              </>
                            );
                          })()}
                        </>
                      )}
                      {rows.map((r, i) => (
                        <text key={i} className={r.cls} x={textX} y={r.y}>
                          {r.text}
                        </text>
                      ))}
                      {lod === "full" && person.unverified && (
                        <circle
                          cx={CARD_W - 15}
                          cy={13}
                          r={3.5}
                          fill="var(--ink-3)"
                        />
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
          <g className="ghosts">
            {ghosts.map((g) => (
              <g key={g.key} className="ghost">
                <path
                  className="ghost-link"
                  d={`M ${g.fromX} ${g.fromY} L ${g.x + CARD_W / 2} ${g.y + CARD_H / 2}`}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  className="ghost-plate"
                  x={g.x}
                  y={g.y}
                  width={CARD_W}
                  height={CARD_H}
                  rx={10}
                  vectorEffect="non-scaling-stroke"
                />
                {lod !== "blocks" && (
                  <>
                    {wrap(g.name, 22, 2).map((line, i) => (
                      <text
                        key={i}
                        className="ghost-name"
                        x={g.x + CARD_W / 2}
                        y={g.y + CARD_H / 2 - 12 + i * 21}
                      >
                        {line}
                      </text>
                    ))}
                    <text
                      className="ghost-note"
                      x={g.x + CARD_W / 2}
                      y={g.y + CARD_H - 26}
                    >
                      awaiting confirmation
                    </text>
                  </>
                )}
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

export { MIN_K, MAX_K };
