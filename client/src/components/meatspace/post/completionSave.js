/**
 * Starts a completion save immediately while absorbing its rejection until the
 * user chooses Finish or Continue. A failed request is retried by that action;
 * a successful request is never repeated.
 */
export function startRetryableSave(action) {
  let resultPromise;

  function start() {
    resultPromise = Promise.resolve()
      .then(action)
      .then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      );
  }

  start();

  return async function ensureSaved() {
    let result = await resultPromise;
    if (!result.ok) {
      start();
      result = await resultPromise;
    }
    if (!result.ok) throw result.error;
    return result.value;
  };
}

export function startRetryableSaves(actions) {
  const ensureSaved = actions.filter(Boolean).map(startRetryableSave);
  return () => Promise.all(ensureSaved.map(save => save()));
}
