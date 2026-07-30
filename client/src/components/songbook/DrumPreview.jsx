import { useCallback, useEffect, useMemo, useState } from 'react';
import useDrumPlayer from '../../hooks/useDrumPlayer.js';
import { chartHasMusic, parseDrumChart } from '../../lib/drumNotation.js';
import DrumSheetView from './DrumSheetView.jsx';
import DrumTransportBar from './DrumTransportBar.jsx';

/**
 * Audible drum-chart preview shared by the SongBook editor and importer.
 *
 * Playback uses a snapshot captured when Play is pressed. The live source can
 * therefore keep changing without rebuilding the Web Audio schedule mid-run.
 * While that happens the sheet stays on the sounding snapshot too, keeping its
 * playhead aligned with what the user hears.
 */
export default function DrumPreview({
  text,
  songId,
  fontSizeRem,
  sheetClassName = '',
}) {
  const [snapshot, setSnapshot] = useState(text);
  const [playAfterReload, setPlayAfterReload] = useState(false);
  const player = useDrumPlayer(snapshot, { songId });
  const chartChanged = text !== snapshot;
  const liveHasMusic = useMemo(() => chartHasMusic(parseDrumChart(text)), [text]);

  const toggle = useCallback(() => {
    if (player.playing) {
      player.toggle();
      return;
    }
    if (text !== snapshot) {
      setSnapshot(text);
      setPlayAfterReload(true);
      return;
    }
    player.toggle();
  }, [player.playing, player.toggle, snapshot, text]);

  // A snapshot update rebuilds the idle player. Start only after that render so
  // toggle() cannot accidentally launch the stale chart from the click render.
  useEffect(() => {
    if (!playAfterReload || snapshot !== text) return;
    setPlayAfterReload(false);
    player.toggle();
  }, [playAfterReload, player.toggle, snapshot, text]);

  const displayedText = player.playing ? snapshot : text;

  return (
    <div className="min-w-0">
      <DrumTransportBar
        playing={player.playing}
        onToggle={toggle}
        hasMusic={chartChanged ? liveHasMusic : player.hasMusic}
        bpm={player.bpm}
        onBpmChange={player.setBpm}
        onPercent={player.setBpmPercent}
        writtenTempo={player.writtenTempo}
        countInBars={player.countInBars}
        onCountInChange={player.setCountInBars}
        loopEnabled={player.loopEnabled}
        onLoopToggle={player.setLoopEnabled}
        loopFrom={player.loopFrom}
        loopTo={player.loopTo}
        onLoopRangeChange={player.setLoopRange}
        barCount={player.barCount}
        clickEnabled={player.clickEnabled}
        onClickToggle={player.setClickEnabled}
        beatsPerBar={player.beatsPerBar}
        pulse={player.pulse}
        currentBar={player.currentBar}
      />
      {chartChanged && (
        <p className="px-3 py-1.5 text-xs text-port-warning bg-port-warning/10" role="status">
          Chart changed — press Play to reload.
        </p>
      )}
      <div className={sheetClassName}>
        <DrumSheetView
          text={displayedText}
          fontSizeRem={fontSizeRem}
          getPlayhead={player.getPlayhead}
          playing={player.playing}
        />
      </div>
    </div>
  );
}
