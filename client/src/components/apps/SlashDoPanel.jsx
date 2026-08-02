import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Terminal, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { NON_PM2_TYPES } from './constants';
import { slashdoLabel, slashdoWorkflowsForApp } from '../../lib/slashdoCatalog';
import SlashDoRunDrawer from './SlashDoRunDrawer';
import * as api from '../../services/api';

// The launchable set comes from `client/src/lib/slashdoCatalog.js` — the mirror of
// the server catalog that also backs the CoS quick templates and the
// `POST /api/cos/tasks/slashdo` allowlist (#3114). Adding a workflow there lights
// it up in every surface at once.

export default function SlashDoPanel({ appId, appName, appType }) {
  const [loading, setLoading] = useState(null);
  // A `configurable` command opens a pre-flight drawer instead of firing
  // immediately: the run's provider / model / effort / reviewer / simplify
  // settings, plus (for `/do:next`) which work item to claim. Holds the whole
  // command entry so the drawer is titled and queued for the one that was
  // clicked. Every other command still queues on one click.
  const [drawerCommand, setDrawerCommand] = useState(null);
  const navigate = useNavigate();
  const isSwiftApp = NON_PM2_TYPES.has(appType);

  const commands = slashdoWorkflowsForApp(isSwiftApp);

  const goToQueue = (label) => {
    toast.success(`Queued ${label} agent task`);
    navigate('/cos/agents');
  };

  const handleRun = async (command) => {
    if (command.configurable) {
      setDrawerCommand(command);
      return;
    }
    const label = slashdoLabel(command.command);
    setLoading(command.command);
    const result = await api.createSlashdoTask(command.command, appId, {}, { silent: true }).catch(err => {
      toast.error(err.message || `Failed to queue ${label}`);
      return null;
    });
    setLoading(null);
    if (result) goToQueue(label);
  };

  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Agent Operations</div>
      <div className="flex flex-wrap gap-2">
        {commands.map(cmd => (
          <button
            key={cmd.command}
            onClick={() => handleRun(cmd)}
            disabled={!!loading}
            title={cmd.configurable ? `${cmd.description} — opens run settings` : cmd.description}
            className={`px-3 py-1.5 ${cmd.classes} rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors border`}
          >
            {loading === cmd.command ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
            {slashdoLabel(cmd.command)}
          </button>
        ))}
      </div>
      {/* Mounted only while open — the drawer fetches providers on mount, and
          unmounting is what resets the form between runs. */}
      {drawerCommand && (
        <SlashDoRunDrawer
          open
          command={drawerCommand.command}
          label={slashdoLabel(drawerCommand.command)}
          appId={appId}
          appName={appName}
          onClose={() => setDrawerCommand(null)}
          onQueued={() => {
            const label = slashdoLabel(drawerCommand.command);
            setDrawerCommand(null);
            goToQueue(label);
          }}
        />
      )}
    </div>
  );
}
