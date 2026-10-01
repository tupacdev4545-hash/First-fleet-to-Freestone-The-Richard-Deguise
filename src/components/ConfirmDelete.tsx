import { useEffect, useRef, useState } from "react";
import { readPasscode, rememberPasscode, type LivePhoto } from "../lib/api";

interface Props {
  photo: LivePhoto;
  personName: string;
  onConfirm: (passcode: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Deleting a photograph is the one action here that destroys something, so it
 * asks first — showing the actual picture, because "are you sure?" over a
 * greyed-out screen means nothing if you cannot see what you are about to
 * lose. The passcode is required again for the same reason the upload needs
 * it: this reaches everyone, not just the person clicking.
 */
export default function ConfirmDelete({
  photo,
  personName,
  onConfirm,
  onCancel,
}: Props) {
  const [passcode, setPasscode] = useState(readPasscode);
  const [state, setState] = useState<"idle" | "working">("idle");
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state !== "working") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, state]);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setState("working");
    setError("");
    try {
      await onConfirm(passcode.trim());
      if (passcode.trim()) rememberPasscode(passcode.trim());
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : "Could not remove it.");
    }
  }

  return (
    <div className="overlay" onClick={() => state !== "working" && onCancel()}>
      <div
        className="modal narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Remove this photograph"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={go}>
          <h2>Remove this photograph?</h2>
          <p className="lede">
            It comes off {personName}'s record for everyone, and the file is
            deleted. This cannot be undone from here.
          </p>

          <div className="confirm-shot">
            <img src={photo.src} alt="" />
            {photo.caption && <figcaption>{photo.caption}</figcaption>}
          </div>

          <div className="field">
            <label htmlFor="delete-passcode">Family passcode</label>
            <input
              id="delete-passcode"
              ref={field}
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="off"
              required
              placeholder="the word the family shares"
            />
          </div>

          {error && <p className="error">{error}</p>}

          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              disabled={state === "working"}
            >
              Keep it
            </button>
            <button
              type="submit"
              className="btn danger"
              disabled={state === "working"}
            >
              {state === "working" ? "Removing…" : "Delete permanently"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
