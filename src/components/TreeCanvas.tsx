import { useCallback, useEffect, useMemo, useRef } from "react";
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
}: Props) {
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Survives pointerup so the click handler can tell a drag from a tap. */
  const moved = useRef(false);
  /**
   * Every finger currently down. The stage sets `touch-action: none`, which
   * tells the browser we will handle pinching ourselves — so we have to.
   */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  /** The span and centre of a two-finger gesture, as it was last frame. */
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  /** For double-tap to zoom, which is how most people zoom one-handed. */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

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

  /** The two-finger span and midpoint, in stage coordinates. */
  const gesture = () => {
    const [a, b] = [...touches.current.values()];
    const p = local(a.x, a.y);
    const q = local(b.x, b.y);
    return {
      dist: Math.hypot(q.x - p.x, q.y - p.y),
      cx: (p.x + q.x) / 2,
      cy: (p.y + q.y) / 2,
    };
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
        const factor = Math.exp(-e.deltaY * 0.0016);
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
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel, stageRef]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.current.size === 2) {
      // A second finger turns a drag into a pinch.
      pinch.current = gesture();
      drag.current = null;
      moved.current = true;
      return;
    }

    // Deliberately no setPointerCapture: capturing on the stage would retarget
    // the click away from the person node underneath the cursor.
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    moved.current = false;
    stageRef.current?.classList.add("dragging");

    // Double tap zooms in on the spot touched — the one-handed gesture.
    if (e.pointerType !== "mouse") {
      const now = performance.now();
      const prev = lastTap.current;
      if (
        prev &&
        now - prev.t < 320 &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 34
      ) {
        const p = local(e.clientX, e.clientY);
        zoomAbout(1.9, p.x, p.y);
        moved.current = true;
        lastTap.current = null;
        return;
      }
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers: scale by how much the span changed, and pan by how far the
    // midpoint travelled, so pinching and dragging work in the same motion.
    if (touches.current.size >= 2) {
      const was = pinch.current;
      const now = gesture();
      if (was && was.dist > 0) {
        const factor = now.dist / was.dist;
        onCamera((c) => {
          const k = Math.min(MAX_K, Math.max(MIN_K, c.k * factor));
          const ratio = k / c.k;
          return {
            k,
            x: now.cx - (was.cx - c.x) * ratio,
            y: now.cy - (was.cy - c.y) * ratio,
          };
        });
      }
      pinch.current = now;
      moved.current = true;
      return;
    }

    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
    d.x = e.clientX;
    d.y = e.clientY;
    onCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };

  const endDrag = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;

    // Lifting one finger of a pinch hands control back to the one still down,
    // rather than jumping the tree by the gap between them.
    if (touches.current.size === 1) {
      const [id] = [...touches.current.keys()];
      const p = touches.current.get(id)!;
      drag.current = { id, x: p.x, y: p.y };
      return;
    }

    if (drag.current?.id === e.pointerId) drag.current = null;
    if (touches.current.size === 0) {
      stageRef.current?.classList.remove("dragging");
    }
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
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={endDrag}
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
                          <text
                            className="initials"
                            x={38}
                            y={CARD_H / 2 + 1}
                            fill={colour}
                          >
                            {initials(person.name)}
                          </text>
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
