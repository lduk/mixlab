// Sample times are always in the source buffer. Tempo belongs to the editor.
const rate = 44100
const cacheName = 'mixlab-separation-v1'
export async function modelCached() {
  try {
    const cache = await caches.open(cacheName)
    return Boolean(await cache.match(new URL('ai-assets/UVR_MDXNET_Main.onnx', import.meta.url)))
  } catch { return false }
}

export function deviceLimit(seconds) {
  if (!isSecureContext || !globalThis.Worker || !globalThis.OfflineAudioContext || !globalThis.crypto?.subtle)
    return 'Separacja wymaga HTTPS lub localhost oraz obsługi Web Audio i Web Workerów.'
  // Validate a tiny i8x16.splat module without loading the runtime.
  const simd = [0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11]
  if (!globalThis.WebAssembly?.validate(new Uint8Array(simd)))
    return 'Ta przeglądarka nie obsługuje WebAssembly SIMD. Zaktualizuj przeglądarkę.'
  const memory = navigator.deviceMemory
  if (memory && memory < 2) return 'Model potrzebuje więcej pamięci niż zgłasza urządzenie.'
  const limit = memory && memory <= 4 ? 90 : 600
  if (seconds > limit) return 'Wybierz na fali fragment do '+limit+' s. Dłuższy zakres przekracza budżet pamięci tej wersji.'
  return ''
}

export async function separateClip(buffer, begin, end, signal, progress) {
  const reason = deviceLimit(end-begin)
  if (reason) throw Error(reason)
  const length = Math.max(1, Math.ceil((end-begin)*rate))
  progress({stage:'Przygotowanie dźwięku 44,1 kHz'})
  const offline = new OfflineAudioContext(2,length,rate)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start(0,begin,end-begin)
  const pcm = await offline.startRendering()
  signal.throwIfAborted()
  const worker = new Worker(new URL('./stems-worker.js',import.meta.url),{type:'module'})
  try {
    const data = await new Promise((resolve,reject) => {
      signal.addEventListener('abort',()=>{worker.terminate();reject(signal.reason)},{once:true})
      worker.onerror = event => reject(Error(event.message || 'Przeglądarka zakończyła proces separacji. Spróbuj krótszego zaznaczenia.'))
      worker.onmessageerror = () => reject(Error('Nie można odczytać wyniku z procesu separacji.'))
      worker.onmessage = ({data}) => {
        if (data.type==='progress') progress(data)
        if (data.type==='error') reject(Error(data.message))
        if (data.type==='result') resolve(data)
      }
      const channels = [0,1].map(ch=>pcm.getChannelData(ch).slice())
      worker.postMessage({channels},channels.map(channel=>channel.buffer))
    })
    signal.throwIfAborted()
    for (const key of ['vocals','accompaniment']) {
      const packed = data[key]
      if (data.rate!==rate || packed.length!==2*length) throw Error('Błędna długość ścieżki modelu.')
      const track = new AudioBuffer({numberOfChannels:2,length,sampleRate:rate})
      for (const ch of [0,1]) track.copyToChannel(packed.subarray(ch*length,(ch+1)*length),ch)
      data[key] = track
    }
    return data
  } finally { worker.terminate() }
}
