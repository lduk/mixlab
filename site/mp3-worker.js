// lamejs 1.2.1, https://github.com/zhuker/lamejs
importScripts('vendor/lame-1.2.1.min.js')
self.onmessage = ({data: {channels, rate}}) => {
  const encoder = new lamejs.Mp3Encoder(2, rate, 192)
  const chunks = []
  for (let start = 0; start < channels[0].length; start += 1152) {
    const pcm = channels.map(channel => Int16Array.from(
      channel.subarray(start, start + 1152),
      sample => Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
    ))
    chunks.push(encoder.encodeBuffer(...pcm))
  }
  chunks.push(encoder.flush())
  self.postMessage(new Blob(chunks, {type: 'audio/mpeg'}))
}
