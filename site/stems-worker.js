import {PffftSTFT} from './vendor/stems-dsp/stft.js'

const modelHash = '8289784cda38543ff431add4070662813311a8cccfc0112ca82f76d9dba2b4ca'
const modelBytes = 66759214
const assets = new URL('ai-assets/',self.location.href)
const cacheName = 'mixlab-separation-v1'
const chunk = 255*1024
const overlap = 32768
const hop = chunk-overlap
const rate = 44100

function report(stage,done,total) {
  self.postMessage({type:'progress',stage,done,total})
}
async function digest(buffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
}

async function loadModel(cache) {
  const url = new URL('UVR_MDXNET_Main.onnx',assets)
  const cached = await cache?.match(url).catch(()=>null)
  if (cached) {
    const data = await cached.arrayBuffer().catch(()=>null)
    if (data?.byteLength===modelBytes && await digest(data)===modelHash) return data
    await cache.delete(url).catch(()=>{})
  }
  const response = await fetch(url)
  if (!response.ok) throw Error('Nie udało się pobrać modelu UVR ('+response.status+').')
  const reader = response.body.getReader(), bytes=new Uint8Array(modelBytes)
  let received=0
  report('Pobieranie wag',0,modelBytes)
  while(true) {
    const {done,value}=await reader.read()
    if(done)break
    if(received+value.length>modelBytes) throw Error('Błędny rozmiar wag.')
    bytes.set(value,received)
    received+=value.length
    report('Pobieranie wag',received,modelBytes)
  }
  if(received!==modelBytes || await digest(bytes)!==modelHash)throw Error('Weryfikacja SHA-256 wag nie powiodła się.')
  await cache?.put(url,new Response(bytes)).catch(()=>{})
  return bytes
}

// The model predicts stereo vocals. Predict on overlapping context,
// discard unreliable outer samples and blend the remaining overlap linearly.
async function infer(ort,session,input,backend) {
  const length=input[0].length
  const output=new Float32Array(2*length)
  const fft=new PffftSTFT(7680,1024,3072)
  await fft.init()
  let peak=.000001
  for(const channel of input)for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(channel[i]))
  const margin=overlap/2
  const block=new Float32Array(2*chunk)
  const count=Math.max(1,Math.ceil((length+2*margin-overlap)/hop))
  for(let n=0;n<count;n++){
    const offset=n*hop-margin
    for(let ch=0;ch<2;ch++){
      for(let i=0;i<chunk;i++){
        const src=offset+i
        block[ch*chunk+i]=(src>=0 && src<length) ? input[ch][src]/peak : 0
      }
    }
    report('Separacja · '+backend,n,count)
    const tensor=new ort.Tensor('float32',fft.forward(block,1,chunk),[1,4,3072,256])
    const result=await session.run({[session.inputNames[0]]:tensor})
    const prediction=result[session.outputNames[0]]
    const pcm=fft.inverse(prediction.data,1)
    tensor.dispose()
    prediction.dispose()
    for(let i=Math.max(0,-offset);i<Math.min(chunk,length-offset);i++){
      // Use a raised cosine in the middle half of the shared 32k samples.
      const fadeIn=n>0 && i<overlap
      const fadeOut=n<count-1 && i>=hop
      let weight=1
      if(fadeIn || fadeOut){
        const progress=(fadeIn ? i : i-hop)/overlap
        const phase=Math.max(0,Math.min(1,2*progress-.5))
        const up=.5-.5*Math.cos(Math.PI*phase)
        weight=fadeIn ? up : 1-up
      }
      for(let ch=0;ch<2;ch++)output[ch*length+offset+i]+=pcm[ch*chunk+i]*weight*peak*1.043
    }
    report('Separacja · '+backend,n+1,count)
  }
  for(const sample of output)if(!Number.isFinite(sample))throw Error('Model zwrócił niepoprawne próbki.')
  return output
}

async function separate({channels,forceWasm}) {
  const start=performance.now(),length=channels[0].length
  const cache=await self.caches?.open(cacheName).catch(()=>null)
  const fingerprints=[]
  for(const channel of channels)fingerprints.push(await digest(channel))
  const key=new URL('stem-results/'+modelHash+'-vocal-ola2-'+fingerprints.join('-'),self.location.href)
  const cached=await cache?.match(key).catch(()=>null)
  let vocals,backend='pamięć lokalna',stored=false
  if(cached){
    const data=await cached.arrayBuffer().catch(()=>null)
    if(data?.byteLength===2*length*4){
      vocals=new Float32Array(data)
      stored=true
    }
  }
  if(!vocals){
    report('Przygotowanie modelu')
    const weights=await loadModel(cache)
    const ort=await import('./ai-assets/ort.min.mjs')
    ort.env.wasm.wasmPaths=assets.href
    ort.env.wasm.numThreads=1
    const gpu=!forceWasm && await navigator.gpu?.requestAdapter().catch(()=>null)
    for(const provider of gpu ? ['webgpu','wasm'] : ['wasm']){
      let session
      backend=provider==='wasm' ? 'WASM' : 'WebGPU'
      try {
        report('Uruchamianie · '+backend)
        session=await ort.InferenceSession.create(weights,{executionProviders:[provider],graphOptimizationLevel:'all'})
        vocals=await infer(ort,session,channels,backend)
        break
      }catch(error){
        if(provider==='wasm')throw error
      }finally{await session?.release().catch(()=>{})}
    }
    if(cache)stored=await cache.put(key,new Response(vocals)).then(()=>true,()=>false)
  }
  const accompaniment=new Float32Array(length*2)
  for(let ch=0;ch<2;ch++)for(let i=0;i<length;i++)accompaniment[ch*length+i]=channels[ch][i]-vocals[ch*length+i]
  self.postMessage({type:'result',accompaniment,vocals,rate,backend,stored,seconds:(performance.now()-start)/1000},
    [accompaniment.buffer,vocals.buffer])
}

self.onmessage=event=>separate(event.data).catch(error=>self.postMessage({type:'error',
  message:'Separacja nie powiodła się. '+(error?.message || '')+' Spróbuj krótszego fragmentu albo urządzenia z większą pamięcią.'}))
