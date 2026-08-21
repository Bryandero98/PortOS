/**
 * FableLoom play panel — the reader-side chat for one episode.
 *
 * The reader types what they want to do; the play stage matches it against
 * the current scene's intent paths and either moves them (new scene prose +
 * image) or answers in-world without leaving the scene. The session lives in
 * this panel's state (current scene + transcript) — restarting is free, and
 * nothing persists server-side.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, Send, Flag } from 'lucide-react';
import MediaImage from '../MediaImage';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { playLoomTurn } from '../../services/api';

const findNode = (episode, id) => episode?.nodes.find((n) => n.id === id) || null;

// Reader-facing projection of an authored node (mirrors the server's
// publicNode shape, for local moves that never hit the API).
const asPublic = (node) => (node ? {
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
  isEnding: !!node.isEnding,
  endingLabel: node.endingLabel,
  choices: (node.transitions || []).map((t) => ({ id: t.id, intent: t.intent })),
} : null);

export default function LoomPlayPanel({ loom, episode }) {
  // Anchored on scalars so an authoring echo elsewhere in the loom (a node
  // PATCH, a drag) doesn't mint a new `start` identity and wipe an
  // in-progress read-through. The trade: mid-session edits to the opening
  // scene's text don't reach an open drawer until restart.
  const start = useMemo(
    () => asPublic(findNode(episode, episode?.startNodeId)),
    [episode.id, episode.startNodeId],
  );
  const [scene, setScene] = useState(start);
  const [transcript, setTranscript] = useState([]);
  const [message, setMessage] = useState('');
  const scrollRef = useRef(null);
  // Mirrors the server's terminal rule: an ending, or a dead-end scene with
  // no paths out, ends the read-through.
  const ended = !!scene && (scene.isEnding || !scene.choices?.length);

  const restart = () => {
    setScene(start);
    setTranscript([]);
    setMessage('');
  };

  // An episode switch (or a changed opening scene) re-anchors the session.
  useEffect(() => { restart(); }, [start]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript, scene]);

  const [runTurn, sending] = useAsyncAction(async (text, history) => {
    const result = await playLoomTurn(loom.id, episode.id, {
      nodeId: scene.id,
      message: text,
      // The transcript state also holds scene cards ({ role: 'scene', node })
      // — the API accepts only reader/narrator text turns, so filter first or
      // every turn after the first move fails validation.
      transcript: history
        .filter((t) => t.role === 'reader' || t.role === 'narrator')
        .slice(-12)
        .map(({ role, text: t }) => ({ role, text: t })),
    }, { silent: true });
    const additions = [];
    if (result.narration) additions.push({ role: 'narrator', text: result.narration });
    if (result.action === 'move' && result.node) {
      setScene(result.node);
      additions.push({ role: 'scene', node: result.node });
    }
    if (additions.length) setTranscript((prev) => [...prev, ...additions]);
  }, { errorMessage: 'The narrator lost the thread — try again' });

  const send = () => {
    const text = message.trim();
    if (!text || sending || !scene) return;
    setMessage('');
    const history = [...transcript, { role: 'reader', text }];
    setTranscript(history);
    runTurn(text, history);
  };

  if (!start) {
    return (
      <p className="p-4 text-sm text-port-text-muted">
        This episode has no opening scene yet — weave or add scenes first.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        <SceneCard node={start} isOpening />
        {transcript.map((turn, i) => {
          if (turn.role === 'scene') return <SceneCard key={i} node={turn.node} />;
          return (
            <div key={i} className={turn.role === 'reader' ? 'text-right' : ''}>
              <div
                className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-left ${
                  turn.role === 'reader'
                    ? 'bg-port-accent/15 text-port-text'
                    : 'bg-port-card border border-port-border text-port-text'
                }`}
              >
                {turn.text}
              </div>
            </div>
          );
        })}
        {ended && (
          <div className="flex items-center gap-2 justify-center text-port-success text-sm font-medium py-2">
            <Flag size={14} />
            {scene?.endingLabel ? `Ending: ${scene.endingLabel}` : 'The End'}
          </div>
        )}
      </div>
      <div className="border-t border-port-border p-3 space-y-2">
        {!ended && scene?.choices?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scene.choices.filter((c) => c.intent).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setMessage(c.intent)}
                className="text-xs px-2 py-1 rounded-full border border-port-border text-port-text-muted hover:border-port-accent hover:text-port-accent"
              >
                {c.intent}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm"
            placeholder={ended ? 'The story has ended' : 'What do you do?'}
            aria-label="Your action"
            value={message}
            disabled={ended || sending}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          {ended ? (
            <button
              type="button"
              onClick={restart}
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent/15 text-port-accent text-sm"
            >
              <RotateCcw size={14} /> Read again
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={sending || !message.trim()}
              aria-label="Send"
              className="px-3 py-2 rounded bg-port-accent text-white disabled:opacity-50"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SceneCard({ node, isOpening = false }) {
  if (!node) return null;
  return (
    <div className="border border-port-border rounded-lg overflow-hidden bg-port-card">
      {node.image && (
        <MediaImage src={`/data/images/${node.image}`} alt={node.title || 'Scene'} className="w-full max-h-56 object-cover" />
      )}
      <div className="p-3">
        <div className="text-xs uppercase tracking-wide text-port-text-muted mb-1">
          {isOpening ? 'Opening' : node.isEnding ? (node.endingLabel || 'Ending') : node.title || 'Scene'}
        </div>
        <p className="text-sm whitespace-pre-wrap">{node.prose}</p>
      </div>
    </div>
  );
}
