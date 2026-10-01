import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  subtitle?: string;
  onDone: () => void;
}

const HOLD_MS = 3200;
/** Ignore skips for this long, so a stray click on load cannot kill it. */
const ARM_AFTER_MS = 800;

/**
 * The opening. A line-drawn tree grows, the name settles in under it, then the
 * whole thing lifts away. Any click or key skips it, and anyone who has asked
 * their system for reduced motion gets the still frame and a quick fade.
 */
export default function Splash({ title, subtitle, onDone }: Props) {
  const [leaving, setLeaving] = useState(false);
  // Held in a ref so a re-render of the app cannot restart the timers.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let gone: number;
    let armed = false;

    const leave = () => {
      setLeaving(true);
      gone = window.setTimeout(() => done.current(), 520);
    };
    const hold = window.setTimeout(leave, reduced ? 900 : HOLD_MS);
    const arm = window.setTimeout(() => {
      armed = true;
    }, ARM_AFTER_MS);

    const skip = () => {
      if (!armed) return;
      window.clearTimeout(hold);
      leave();
    };
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);

    return () => {
      window.clearTimeout(hold);
      window.clearTimeout(gone);
      window.clearTimeout(arm);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
    // Deliberately empty: this runs once, and never restarts mid-animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const words = title.split(" ");

  return (
    <div className={`splash${leaving ? " leaving" : ""}`} aria-hidden="true">
      <div className="splash-inner">
        <svg className="splash-tree" viewBox="0 0 200 170" fill="none">
          <g
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path className="grow g1" d="M100 168 V96" />
            <path className="grow g2" d="M100 122 C100 106, 78 100, 66 88" />
            <path className="grow g2" d="M100 122 C100 106, 122 100, 134 88" />
            <path className="grow g3" d="M100 96 C100 78, 80 70, 70 56" />
            <path className="grow g3" d="M100 96 C100 78, 120 70, 130 56" />
            <path className="grow g4" d="M70 56 C64 46, 52 44, 44 36" />
            <path className="grow g4" d="M70 56 C72 44, 84 38, 88 28" />
            <path className="grow g4" d="M130 56 C136 46, 148 44, 156 36" />
            <path className="grow g4" d="M130 56 C128 44, 116 38, 112 28" />
          </g>
          <g fill="currentColor">
            <circle className="bud b1" cx="44" cy="36" r="5" />
            <circle className="bud b2" cx="88" cy="28" r="5" />
            <circle className="bud b3" cx="112" cy="28" r="5" />
            <circle className="bud b4" cx="156" cy="36" r="5" />
            <circle className="bud b5" cx="66" cy="88" r="4.5" />
            <circle className="bud b6" cx="134" cy="88" r="4.5" />
          </g>
        </svg>

        <h1 className="splash-title">
          {words.map((w, i) => (
            <span key={i} style={{ animationDelay: `${900 + i * 130}ms` }}>
              {w}
            </span>
          ))}
        </h1>

        {subtitle && <p className="splash-sub">{subtitle}</p>}
        <p className="splash-skip">Click anywhere to skip</p>
      </div>
    </div>
  );
}
