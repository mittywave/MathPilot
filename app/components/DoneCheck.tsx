"use client";

import { type CSSProperties, useState } from "react";

// The burst around a fresh tick: where each star flies (degrees from the right, then px from the centre) and how big it is.
// Gold five-point stars alternate with small green sparkles; the CSS gives them their shapes, colours and timing.
const STARS = [[-75, 26, 10], [-28, 21, 6], [18, 27, 8], [62, 21, 5], [110, 26, 9], [155, 22, 6], [200, 27, 8], [245, 21, 5]] as const;

/**
 * A task-list tick for marking a piece of work done: an empty ring that previews the tick on hover and a filled tick
 * once done; clicking a filled tick undoes it. Ticking it by hand scatters a few stars beside it. Undoing, or a tick
 * that arrives with refreshed data, stays quiet, so the stars always answer the teacher's own click.
 */
export function DoneCheck({ checked, label, title, disabled, busy, onToggle }: {
  checked: boolean; label: string; title: string; disabled?: boolean; busy?: boolean; onToggle: () => void;
}) {
  // A click on the empty ring arms the burst; the stars fly when `checked` turns true, whether at once or after a save.
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(checked);
  const [burst, setBurst] = useState(0);
  if (checked !== shown) {
    setShown(checked);
    setArmed(false);
    if (checked && armed) setBurst(burst + 1);
  }
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} title={title} aria-busy={busy || undefined} disabled={disabled}
    className="done-check" data-burst={burst > 0 || undefined} onClick={() => { setArmed(!checked); onToggle(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" /><path d="m7.6 12.4 3 3 5.8-6.3" /></svg>
    {burst > 0 && <span key={burst} className="done-burst" aria-hidden="true" onAnimationEnd={(event) => { if (event.animationName === "done-burst") setBurst(0); }}>
      {STARS.map(([angle, distance, size], index) => <i key={index} style={{ "--angle": `${angle}deg`, "--distance": `${distance}px`, "--size": `${size}px` } as CSSProperties} />)}
    </span>}
  </button>;
}
