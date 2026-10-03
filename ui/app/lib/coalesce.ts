/**
 * A refresher that never overlaps itself and never piles up: calls within
 * `wait` ms make one run, and calls while a run is in flight make one more
 * run after it ends. Returns the function to call.
 */
export function coalesce(run: () => Promise<unknown>, wait = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  const fire = () => {
    timer = null;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    Promise.resolve()
      .then(run)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(fire, wait);
  };
  return schedule;
}
