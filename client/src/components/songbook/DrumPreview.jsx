import { useCallback, useEffect, useMemo, useState } from 'react';
import useDrumPlayer from '../../hooks/useDrumPlayer.js';
import useWakeLock from '../../hooks/useWakeLock.js';
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
  settingsMirror,
}) {
  const [snapshot, setSnapshot] = useState(text);
  const [playAfterReload, setPlayAfterReload] = useState(false);
  const player = useDrumPlayer(snapshot, { songId });
  const chartChanged = text !== snapshot;
  const liveHasMusic = useMemo(() => chartHasMusic(parseDrumChart(text)), [text]);
  useWakeLock(player.playing);

  const setBpm = useCallback((next) => {
    player.setBpm(next);
    settingsMirror?.setBpm(next);
  }, [player.setBpm, settingsMirror]);
  const setBpmPercent = useCallback((percent) => {
    player.setBpmPercent(percent);
    settingsMirror?.setBpm(Math.round((player.writtenTempo * percent) / 100));
  }, [player.setBpmPercent, player.writtenTempo, settingsMirror]);
  const setCountInBars = useCallback((next) => {
    player.setCountInBars(next);
    settingsMirror?.setCountInBars(next);
  }, [player.setCountInBars, settingsMirror]);
  const setLoopEnabled = useCallback((enabled) => {
    player.setLoopEnabled(enabled);
    settingsMirror?.setLoopEnabled(enabled);
  }, [player.setLoopEnabled, settingsMirror]);
  const setLoopRange = useCallback((from, to) => {
    player.setLoopRange(from, to);
    settingsMirror?.setLoopRange(from, to);
  }, [player.setLoopRange, settingsMirror]);
  const setClickEnabled = useCallback((enabled) => {
    player.setClickEnabled(enabled);
    settingsMirror?.setClickEnabled(enabled);
  }, [player.setClickEnabled, settingsMirror]);

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
  // toggle() cannot launch the stale chart or run before its tempo seed lands.
  useEffect(() => {
    if (!playAfterReload || snapshot !== text || !player.chartSettingsReady) return;
    setPlayAfterReload(false);
    player.toggle();
  }, [playAfterReload, player.chartSettingsReady, player.toggle, snapshot, text]);

  const displayedText = player.playing ? snapshot : text;

  return (
    <div className="min-w-0">
      {/* A sounding snapshot must keep Stop enabled even if the live draft is silent. */}
      <DrumTransportBar
        playing={player.playing}
        onToggle={toggle}
        hasMusic={player.playing || (chartChanged ? liveHasMusic : player.hasMusic)}
        bpm={player.bpm}
        onBpmChange={setBpm}
        onPercent={setBpmPercent}
        writtenTempo={player.writtenTempo}
        countInBars={player.countInBars}
        onCountInChange={setCountInBars}
        loopEnabled={player.loopEnabled}
        onLoopToggle={setLoopEnabled}
        loopFrom={player.loopFrom}
        loopTo={player.loopTo}
        onLoopRangeChange={setLoopRange}
        barCount={player.barCount}
        clickEnabled={player.clickEnabled}
        onClickToggle={setClickEnabled}
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
