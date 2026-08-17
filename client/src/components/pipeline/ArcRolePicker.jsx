const roleLabel = (role) => role
  .split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

export default function ArcRolePicker({ issue, arcRoles = [], onChange, disabled = false }) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-gray-400">
      <span>Arc role</span>
      <select
        value={issue?.arcRole || ''}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={disabled || arcRoles.length === 0}
        className="rounded-lg border border-port-border bg-port-card px-2 py-2 text-sm text-white disabled:opacity-50"
        title={arcRoles.length === 0 ? 'Arc roles unavailable' : 'Issue arc role'}
      >
        <option value="">None</option>
        {arcRoles.map((role) => (
          <option key={role} value={role}>{roleLabel(role)}</option>
        ))}
      </select>
    </label>
  );
}
