import {SoundTouch, SimpleFilter} from './vendor/soundtouch.js'

export const duration = clip => (clip.end - clip.begin) / clip.speed
const cache = new WeakMap()

async function pitched(clip) {
  const {buffer, begin, end, speed} = clip
  const key = [begin, end, speed].join('/')
  const cached = cache.get(buffer)
  if (cached?.key === key) return cached.result
  const rate = buffer.sampleRate
  const length = Math.max(1, Math.round(duration(clip) * rate))
  const result = new AudioBuffer({length, sampleRate: rate, numberOfChannels: Math.min(2,buffer.numberOfChannels)})
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)
  const first = Math.round(begin * rate), last = Math.round(end * rate)
  const engine = new SoundTouch()
  engine.tempo = speed
  engine.stretch.setParameters(rate, 0, 0, 8)
  const filter = new SimpleFilter({
    extract(target, count, position) {
      for (let i=0; i<count; i++) {
        const frame = first + position + i
        target[2*i] = frame < last ? left[frame] : 0
        target[2*i+1] = frame < last ? right[frame] : 0
      }
      return count
    }
  }, engine)
  const chunk = new Float32Array(8192)
  for (let start=0; start<length; start+=4096) {
    const count = Math.min(4096,length-start)
    filter.extract(chunk,count)
    for (let channel=0; channel<result.numberOfChannels; channel++) {
      const output=result.getChannelData(channel)
      for (let i=0; i<count; i++) output[start+i]=chunk[2*i+channel]
    }
    if (start % 65536 === 0) await new Promise(resolve=>setTimeout(resolve,0))
  }
  cache.set(buffer,{key,result})
  return result
}

export function transitions(items, enabled) {
  for (const clip of items) clip.transitions=[]
  if (!enabled) return
  const sorted=[...items].sort((a,b)=>a.at-b.at)
  sorted.forEach((incoming,i)=>{
    for (const outgoing of sorted.slice(0,i)) {
      if (incoming.track!==outgoing.track) continue
      const overlap=Math.min(outgoing.at+duration(outgoing)-incoming.at,duration(incoming))
      if (overlap<=0) continue
      const length=Math.min(incoming.crossLength ?? overlap,overlap)
      if (!length) continue
      const common={length,linear:incoming.curve==='linear'}
      outgoing.transitions.push({...common,start:incoming.at-outgoing.at,inward:false,overlap})
      incoming.transitions.push({...common,start:0,inward:true,overlap})
    }
  })
}

export function transitionGain(phase, inward, linear) {
  const gain = inward ? phase : 1-phase
  return linear ? gain : Math.sin(gain*Math.PI/2)
}

export function fadeScale(c) {
  const sum = c.fadeIn + c.fadeOut
  return sum > duration(c) ? duration(c) / sum : 1
}

export function envelope(c,t) {
  const length=duration(c)
  const scale=fadeScale(c)
  const attack=c.fadeIn ? Math.min(1,t/(c.fadeIn*scale)) : 1
  let level=Math.min(transitionGain(attack,true,c.attackCurve!=='equal'),c.fadeOut ? (length-t)/(c.fadeOut*scale) : 1)
  for (const tr of c.transitions ?? []) {
    if(t<tr.start || t>tr.start+tr.overlap) continue
    const phase=Math.min(1,(t-tr.start)/tr.length)
    level*=transitionGain(phase,tr.inward,tr.linear)
  }
  if(c.inherited){
    const sourceTime=c.sourceOrigin+c.begin+t*c.speed
    level*=envelope(c.inherited,(sourceTime-c.inherited.begin)/c.inherited.speed)
  }
  return Math.max(0,level)
}

export async function prepare(items) {
  for(const c of items) {
    if(c.preserve && c.speed!==1) c.processed=await pitched(c)
  }
}

export function mixPeak(items) {
  // Synchronous complementary stems reconstruct a single source. Reserve
  // one share of headroom for that pair. Independently moved layers add up.
  const edges=[]
  for(const c of items){
    if(c.stemRole==='original' && c.muted)continue
    const paired=c.stemRole==='vocals' || c.stemRole==='accompaniment'
    const key=paired ? [c.group,c.speed,c.at-c.begin/c.speed,c.preserve].join('/') : null
    for(const [t,sign] of [[c.at,1],[c.at+duration(c),-1]]){
      edges.push({t,delta:sign*c.volume/100,key,role:c.stemRole})
    }
  }
  let sum=0,peak=1
  const groups=new Map()
  for(const {delta,key,role} of edges.sort((a,b)=>a.t-b.t || a.delta-b.delta)){
    if(key){
      const gains=groups.get(key) || {vocals:0,accompaniment:0}
      const previous=Math.max(gains.vocals,gains.accompaniment)
      gains[role]+=delta
      sum+=Math.max(gains.vocals,gains.accompaniment)-previous
      groups.set(key,gains)
    }else sum+=delta
    peak=Math.max(peak,sum)
  }
  return peak
}

function envelopePoints(c,add,rate){
  const scale=fadeScale(c)
  if(c.fadeIn && c.attackCurve==='equal'){
    for(let i=1;i<32;i++)add(c.fadeIn*scale*i/32)
  }
  add(c.fadeIn*scale)
  add(duration(c)-c.fadeOut*scale)
  for(const tr of c.transitions ?? []){
    for(let i=0;i<=48;i++) add(tr.start+tr.length*i/48)
    add(tr.start+tr.overlap)
    add(tr.start+tr.overlap+1/rate)
  }
}

export function schedule(ctx,items,start,from,to,connectLiveOutput) {
  const peak=mixPeak(items)
  const nodes=[]
  for(const c of items){
    const first=Math.max(from,c.at), last=Math.min(to,c.at+duration(c))
    if(last<=first || (c.muted && !connectLiveOutput))continue
    const source=ctx.createBufferSource(), gain=ctx.createGain()
    source.buffer=c.processed || c.buffer
    const speed=c.processed ? 1 : c.speed
    source.playbackRate.value=speed
    const onset=start+first-from, local=first-c.at
    const points=new Set([local,last-c.at])
    envelopePoints(c,t=>points.add(t),ctx.sampleRate)
    if(c.inherited){
      const parent=c.inherited
      envelopePoints(parent,t=>points.add((parent.begin+t*parent.speed-c.sourceOrigin-c.begin)/c.speed),ctx.sampleRate)
    }
    const level=c.volume/100/peak
    for(const t of [...points].filter(t=>t>=local && t<=last-c.at).sort((a,b)=>a-b)){
      const value=envelope(c,t)*(connectLiveOutput ? 1 : level)
      if(t===local) gain.gain.setValueAtTime(value,onset)
      else gain.gain.linearRampToValueAtTime(value,onset+t-local)
    }
    if(c.filter){
      const filter=ctx.createBiquadFilter()
      filter.type=c.filter
      filter.frequency.value=c.filter==='highpass' ? 100 : 3500
      filter.Q.value=Math.SQRT1_2
      source.connect(filter).connect(gain)
    }else source.connect(gain)
    if(connectLiveOutput)connectLiveOutput(gain,c,level)
    else gain.connect(ctx.destination)
    source.start(onset,(c.processed ? 0 : c.begin)+local*speed,(last-first)*speed)
    nodes.push(source)
  }
  return nodes
}
