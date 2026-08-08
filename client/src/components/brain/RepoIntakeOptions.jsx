import { GitBranch, ShieldCheck, Lightbulb } from 'lucide-react';
import ToggleChip from '../ui/ToggleChip';

/**
 * The "this URL is a GitHub repo" affordance shared by both Brain capture boxes
 * (the Quick Capture dashboard widget and the Inbox capture form).
 *
 * Presentational only — the sticky checkbox state and the repo-URL rule live in
 * `hooks/useRepoIntake.js`, whose `repo` this renders. The keys must stay in
 * step with the server's `REPO_INTAKE_KEYS`; parity is pinned by
 * `server/lib/repoIntakeActions.mirror.test.js`.
 */
export const REPO_INTAKE_OPTIONS = [
  {
    key: 'malwareScan',
    label: 'Scan for malware',
    Icon: ShieldCheck,
    hint: 'Read-only static audit of the clone. Produces a CLEAN / CAUTION / DANGEROUS report you can open from the link.',
  },
  {
    key: 'learn',
    label: 'Study for PortOS ideas',
    Icon: Lightbulb,
    hint: 'An agent reads the clone for implementation ideas worth adopting and files the good ones as issues. Clean-room — it never copies code.',
  },
];

/**
 * @param {object} props
 * @param {string} props.idPrefix unique per host form — the checkbox ids/labels
 *   must not collide when both capture boxes are mounted on the same page.
 * @param {{owner: string, repo: string}|null} props.repo parsed repo, or null to
 *   render nothing (the capture isn't a bare repo URL)
 * @param {{malwareScan: boolean, learn: boolean}} props.options
 * @param {(key: string) => void} props.onToggle
 */
export default function RepoIntakeOptions({ idPrefix, repo, options, onToggle }) {
  if (!repo) return null;

  return (
    <div className="mt-3 pt-3 border-t border-port-border space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-gray-400">
        <GitBranch size={12} className="text-port-accent shrink-0" />
        <span>
          <span className="text-gray-200">{repo.owner}/{repo.repo}</span> will be cloned locally.
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {REPO_INTAKE_OPTIONS.map(({ key, label, hint, Icon }) => (
          <ToggleChip
            key={key}
            id={`${idPrefix}-${key}`}
            label={label}
            hint={hint}
            Icon={Icon}
            checked={options[key]}
            onToggle={() => onToggle(key)}
          />
        ))}
      </div>
      {REPO_INTAKE_OPTIONS.some(({ key }) => options[key]) && (
        <p className="text-xs text-gray-500">
          A CoS agent starts once the clone finishes — track it in Chief of Staff.
        </p>
      )}
    </div>
  );
}
