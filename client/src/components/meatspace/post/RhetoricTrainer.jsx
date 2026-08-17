import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle, ChevronRight, Feather, Lightbulb, RotateCcw, Timer } from 'lucide-react';
import { submitTrainingEntry } from '../../../services/api';

const TRAINING_MODULE = 'rhetoric';
const ROUND_SIZE = 5;
const TRAINING_TYPES = {
  meter: 'rhetoric-meter',
  diacope: 'rhetoric-diacope',
  progressia: 'rhetoric-progressia',
  brainstorm: 'rhetoric-brainstorm',
};

export const RHETORIC_MODES = [
  {
    id: 'meter', label: 'Iambic Pentameter', icon: Timer, color: 'text-cyan-400', bgColor: 'bg-cyan-500/20',
    description: 'Write a ten-syllable line with a rising da-DUM pulse.',
    example: 'The rain returns to silver every street.',
    prompts: [
      'Write a line about an empty train station.',
      'Write a line that turns from doubt to hope.',
      'Write a line containing the word “winter”.',
      'Write a line spoken by someone keeping a secret.',
      'Write a line that ends on a strong one-syllable noun.',
    ],
    checklist: ['about ten syllables', 'mostly iambic (da-DUM) feet', 'a clear image or thought'],
  },
  {
    id: 'diacope', label: 'Diacope', icon: Feather, color: 'text-amber-400', bgColor: 'bg-amber-500/20',
    description: 'Make emphasis through repetition separated by a word or phrase.',
    example: 'Run, for the door is closing. Run!',
    prompts: [
      'Write a warning using “stay”.',
      'Write a plea using “listen”.',
      'Write a defiant line using “no”.',
      'Write a comic line using “again”.',
      'Write a sentence where the repeated word changes meaning.',
    ],
    checklist: ['the repeated word is exact or intentionally varied', 'a meaningful gap separates the repetitions', 'the repetition adds urgency or emphasis'],
  },
  {
    id: 'progressia', label: 'Progressia', icon: ChevronRight, color: 'text-purple-400', bgColor: 'bg-purple-500/20',
    description: 'Build an idea step by step until the final phrase lands harder.',
    example: 'A spark became a flame, a flame became a signal.',
    prompts: [
      'Escalate a whisper into a public alarm.',
      'Build a three-step progression from want to need to obsession.',
      'Turn a small kindness into a changed life.',
      'Escalate a disagreement without using the word “anger”.',
      'Build from a single drop of water to a flood.',
    ],
    checklist: ['at least three discernible steps', 'each step intensifies or transforms the last', 'the final step feels earned'],
  },
  {
    id: 'brainstorm', label: 'Rhetorical Brainstorm', icon: Lightbulb, color: 'text-green-400', bgColor: 'bg-green-500/20',
    description: 'Generate several angles quickly, then choose the one with voltage.',
    example: 'One subject, three stances: praise it, attack it, confess about it.',
    prompts: [
      'Brainstorm three openings for a story about a locked room.',
      'Argue for, against, and sideways about convenience.',
      'Find three metaphors for a difficult conversation.',
      'Write three headlines for the same surprising event.',
      'Describe one ordinary object as sacred, dangerous, and ridiculous.',
    ],
    checklist: ['at least three distinct attempts', 'the angles are genuinely different', 'one version takes an unexpected turn'],
  },
];

const modeFor = (id) => RHETORIC_MODES.find((mode) => mode.id === id) || null;

export default function RhetoricTrainer({ mode, onSelectMode, onExitMode, onBack, onContinue }) {
  const selectedMode = modeFor(mode);
  const [promptIndex, setPromptIndex] = useState(0);
  const [response, setResponse] = useState('');
  const [rating, setRating] = useState(null);
  const [results, setResults] = useState([]);
  const [saving, setSaving] = useState(false);
  const roundStart = useRef(Date.now());

  useEffect(() => {
    setPromptIndex(0);
    setResponse('');
    setRating(null);
    setResults([]);
    roundStart.current = Date.now();
  }, [selectedMode?.id]);

  const prompt = selectedMode?.prompts[promptIndex];
  const completed = results.length;
  const average = useMemo(() => completed
    ? Math.round(results.reduce((sum, result) => sum + result.rating, 0) / completed * 20)
    : 0, [completed, results]);

  function resetRound() {
    setPromptIndex(0); setResponse(''); setRating(null); setResults([]); roundStart.current = Date.now();
  }

  function finishRound(nextResults) {
    setSaving(true);
    submitTrainingEntry({
      module: TRAINING_MODULE,
      drillType: TRAINING_TYPES[selectedMode.id],
      score: Math.round(nextResults.reduce((sum, result) => sum + result.rating, 0) / nextResults.length * 20),
      questionCount: nextResults.length,
      correctCount: nextResults.filter((result) => result.rating >= 4).length,
      totalMs: Date.now() - roundStart.current,
    }, { silent: true }).catch(() => {}).finally(() => setSaving(false));
  }

  function submitResponse() {
    if (!response.trim() || rating == null) return;
    const nextResults = [...results, { response: response.trim(), rating }];
    setResults(nextResults);
    setResponse(''); setRating(null);
    if (nextResults.length >= ROUND_SIZE) finishRound(nextResults);
    else setPromptIndex((index) => index + 1);
  }

  if (!selectedMode) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft size={16} /> POST launcher</button>
        <div>
          <div className="flex items-center gap-3"><Feather className="text-port-accent" size={28} /><h2 className="text-2xl font-bold text-white">Rhetoric practice</h2></div>
          <p className="mt-2 text-gray-400 max-w-2xl">Train the small structures that make language memorable. Each round gives you five prompts, a compact craft checklist, and space to make the attempt your own.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {RHETORIC_MODES.map((entry) => {
            const Icon = entry.icon;
            return <button key={entry.id} type="button" onClick={() => onSelectMode(entry.id)} className="text-left bg-port-card border border-port-border rounded-xl p-5 hover:border-port-accent/70 transition-colors">
              <div className="flex items-center gap-3"><span className={`rounded-lg p-2 ${entry.bgColor}`}><Icon size={20} className={entry.color} /></span><h3 className="font-semibold text-white">{entry.label}</h3></div>
              <p className="mt-3 text-sm text-gray-400">{entry.description}</p>
              <p className="mt-3 text-xs text-gray-500">Example: {entry.example}</p>
            </button>;
          })}
        </div>
      </div>
    );
  }

  const Icon = selectedMode.icon;
  const roundComplete = completed >= ROUND_SIZE;
  return <div className="max-w-3xl mx-auto space-y-5">
    <div className="flex items-center justify-between gap-3">
      <button type="button" onClick={onExitMode} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft size={16} /> All rhetoric exercises</button>
      <span className="text-xs text-gray-500">{completed}/{ROUND_SIZE} attempts</span>
    </div>
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Icon size={18} className={selectedMode.color} /><h2 className="text-xl font-semibold text-white">{selectedMode.label}</h2></div><p className="mt-2 text-sm text-gray-400">{selectedMode.description}</p></div><div className="text-right text-xs text-gray-500">Self-score<br /><span className="text-white">{average}%</span></div></div>
      {!roundComplete ? <>
        <div className="mt-6 rounded-lg bg-port-bg border border-port-border p-4"><div className="text-xs uppercase tracking-wide text-port-accent mb-2">Prompt {promptIndex + 1}</div><p className="text-lg text-white">{prompt}</p></div>
        <label htmlFor="rhetoric-response" className="block mt-5 text-sm text-gray-300">Your attempt</label>
        <textarea id="rhetoric-response" value={response} onChange={(event) => setResponse(event.target.value)} rows={5} autoFocus placeholder="Write without over-editing. The first live version is useful data." className="mt-2 w-full bg-port-bg border border-port-border rounded-lg px-3 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y" />
        <div className="mt-4"><p className="text-sm text-gray-400 mb-2">How well did it meet the craft goal?</p><div className="flex flex-wrap gap-2">{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" onClick={() => setRating(value)} aria-label={`Rate ${value} out of 5`} className={`px-4 py-2 rounded border text-sm ${rating === value ? 'border-port-accent bg-port-accent/20 text-white' : 'border-port-border text-gray-400 hover:text-white'}`}>{value}</button>)}</div></div>
        <div className="mt-5 border-t border-port-border pt-4"><p className="text-xs text-gray-500 mb-2">Quick check</p><ul className="grid gap-1 sm:grid-cols-3 text-xs text-gray-400">{selectedMode.checklist.map((item) => <li key={item}>· {item}</li>)}</ul></div>
        <button type="button" onClick={submitResponse} disabled={!response.trim() || rating == null} className="mt-5 w-full rounded-lg bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white py-2.5 font-medium">Save attempt &amp; next</button>
      </> : <div className="mt-6 text-center py-8"><CheckCircle size={42} className="mx-auto text-port-success" /><h3 className="mt-3 text-xl font-semibold text-white">Round complete</h3><p className="mt-2 text-gray-400">You rated this round {average}%. Notice which structure felt easiest to reach for.</p><div className="flex gap-3 justify-center mt-6"><button type="button" onClick={resetRound} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-port-border text-gray-300 hover:text-white"><RotateCcw size={16} /> New round</button><button type="button" onClick={onContinue} disabled={saving} className="px-4 py-2 rounded-lg bg-port-accent text-white disabled:opacity-50">{saving ? 'Logging…' : 'Continue POST'}</button></div></div>}
    </div>
  </div>;
}
