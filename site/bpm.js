// Compare the timing of energy increases in a bounded excerpt of the source.
export function estimateBpm(buffer) {
  const windowSize = Math.max(1, Math.round(buffer.sampleRate * 0.01))
  const frames = Math.min(3000, Math.floor(buffer.length / windowSize))
  if (frames < 400) return null
  const start = Math.floor((buffer.length - frames * windowSize) / 2)
  const channels = Array.from({length: Math.min(2, buffer.numberOfChannels)},
    (_, index) => buffer.getChannelData(index))
  const accents = new Float32Array(frames)
  let previous = 0
  for (let frame = 0; frame < frames; frame++) {
    const first = start + frame * windowSize
    let energy = 0
    for (const channel of channels) {
      for (let i = first; i < first + windowSize; i += 4) energy += channel[i] ** 2
    }
    energy = Math.sqrt(energy / (channels.length * Math.ceil(windowSize / 4)))
    if (frame) accents[frame] = Math.max(0, energy - previous - 0.04 * previous)
    previous = energy
  }
  const energy = accents.reduce((sum, value) => sum + value * value, 0)
  if (energy < 0.0001) return null
  let bestScore = 0.25, result = null
  for (let bpm = 60; bpm <= 200; bpm++) {
    const lag = 60 * buffer.sampleRate / (windowSize * bpm)
    const offset = Math.floor(lag), fraction = lag - offset
    let correlation = 0
    for (let i = offset + 1; i < frames; i++) {
      correlation += accents[i] * (accents[i-offset]*(1-fraction) + accents[i-offset-1]*fraction)
    }
    const score = correlation / energy
    if (score > bestScore) {
      bestScore = score
      result = bpm
    }
  }
  return result
}
