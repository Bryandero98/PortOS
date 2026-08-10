export default function StatusIndicator({ running, paused = false }) {
  const label = !running ? 'Stopped' : paused ? 'Paused' : 'Running';
  const tone = !running
    ? 'bg-gray-700 text-gray-400'
    : paused
      ? 'bg-port-warning/20 text-port-warning'
      : 'bg-port-success/20 text-port-success';
  const dot = !running
    ? 'bg-gray-500'
    : paused
      ? 'bg-port-warning'
      : 'bg-port-success animate-pulse';
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${tone}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </div>
  );
}
