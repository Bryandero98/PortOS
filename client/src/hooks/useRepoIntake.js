import { useMemo } from 'react';
import { useLocalStorageBool } from './useLocalStorageBool.js';
import { parseBareUrl } from '../lib/bareUrl.js';
import { parseGitHubUrl } from '../lib/githubRepoUrl.js';

/**
 * The Brain capture boxes' "this URL is a GitHub repo" state.
 *
 * A bare GitHub repo URL is always cloned by the server, which unlocks two
 * opt-in post-clone CoS agent runs (malware scan / repo study). Both preferences
 * are sticky — same pattern as the Creative toggle — so a user who always wants
 * a malware scan ticks it once.
 *
 * Rendering lives in `components/brain/RepoIntakeOptions.jsx`, which takes the
 * `repo` this returns rather than re-parsing the text.
 */

/** localStorage keys, by action. Reordering the UI table must not rebind these. */
const STORAGE_KEYS = {
  malwareScan: 'brain.repoIntake.malwareScan',
  learn: 'brain.repoIntake.learn',
};

/**
 * `{ owner, repo }` when a capture's ENTIRE text is a GitHub repo URL — i.e.
 * exactly when the server will file it to Links and clone it. Composes the two
 * mirrored rules in the same order `services/brain.js` does (`parseBareUrl` →
 * `parseGitHubUrl`); checking only the second would light the panel up for
 * "check out github.com/owner/repo", which the server files as a thought.
 */
export function capturedGitHubRepo(text) {
  const url = parseBareUrl(text);
  return url ? parseGitHubUrl(url) : null;
}

/**
 * @param {string} text the current capture text
 * @returns {{ repo: object|null, options: object, toggle: (key: string) => void,
 *   intakeFor: (text: string) => object|undefined }}
 *   `repo` is the parsed `{ owner, repo }` (null when the text isn't a bare repo
 *   URL) — both the panel and the host's hint read it, so the text is parsed
 *   once per keystroke rather than once per consumer. `intakeFor(text)` is the
 *   payload to send with a capture: the ticked options when `text` is a repo
 *   URL, else undefined. It re-derives from the SUBMITTED text so a sticky tick
 *   can't ride along on a capture the user retyped into a plain thought.
 */
export function useRepoIntake(text) {
  const [malwareScan, setMalwareScan] = useLocalStorageBool(STORAGE_KEYS.malwareScan, false);
  const [learn, setLearn] = useLocalStorageBool(STORAGE_KEYS.learn, false);

  const repo = useMemo(() => capturedGitHubRepo(text), [text]);
  const options = useMemo(() => ({ malwareScan, learn }), [malwareScan, learn]);
  const setters = { malwareScan: setMalwareScan, learn: setLearn };

  return {
    repo,
    options,
    toggle: (key) => setters[key](v => !v),
    intakeFor: (submitted) => (capturedGitHubRepo(submitted) ? { ...options } : undefined),
  };
}
