// Keep AAC audio at its real timestamps when the stream has gaps in its audio timeline.
// mux.js writes every AAC frame with a fixed 1024-sample duration and only positions the first
// frame of each segment, so a gap *inside* a segment collapses (later audio plays early) and
// reappears at the segment boundary as a cut. Filling such gaps with silent frames before mux.js
// packs them keeps audio in sync — the same approach hls.js takes. Pure functions (unit-tested).

const CLOCK = 90000; // MPEG-TS timestamps tick at 90 kHz.
const MAX_FILL_SECONDS = 2; // Larger jumps are timeline resets/discontinuities, not gaps to fill.

// Silent raw AAC-LC frames (no ADTS header) by channel count; valid at any sample rate.
const SILENT_AAC_LC = {
  1: new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x23, 0x80]),
  2: new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80]),
};

export function frameTicks(frame) {
  return ((frame.sampleCount || 1024) * CLOCK) / frame.samplerate;
}

// Silent frames to insert between the end of the previous frame (prevEndDts) and `frame`.
// Returns [] when there is no gap (or it is negative, too large, or not fillable).
export function silentFramesBefore(prevEndDts, frame) {
  if (prevEndDts == null || !frame.samplerate) return [];
  const ticks = frameTicks(frame);
  const gap = frame.dts - prevEndDts;
  const count = Math.round(gap / ticks);
  const silence = frame.audioobjecttype === 2 ? SILENT_AAC_LC[frame.channelcount] : undefined;
  if (count < 1 || gap > MAX_FILL_SECONDS * CLOCK || !silence) return [];
  // Spread the fill evenly so the real frame keeps its own timestamp.
  return Array.from({ length: count }, (_, i) => {
    const at = Math.round(frame.dts - (count - i) * (gap / count));
    return { ...frame, data: silence, dts: at, pts: at };
  });
}

// Wrap a mux.js AdtsStream so its 'data' events include silent frames for timeline gaps.
export function fillAdtsGaps(adtsStream) {
  const trigger = adtsStream.trigger;
  let nextDts = null;
  adtsStream.trigger = function (type, frame, ...rest) {
    if (type === 'data' && frame && frame.samplerate) {
      for (const silent of silentFramesBefore(nextDts, frame)) trigger.call(this, type, silent, ...rest);
      nextDts = frame.dts + frameTicks(frame);
    }
    return trigger.call(this, type, frame, ...rest);
  };
}
