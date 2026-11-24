const $ = id => document.getElementById(id)
let clips = [], history = [], active = 0, context, sources = []
const current = () => clips[active]
let frame, selection, drag
const duration = c => (c.end - c.begin) / c.speed
function arrangement(){
  let next = 0
  return clips.map(c => {
    const at = c.offset ?? next
    next = at + duration(c)
    return {...c, at}
  })
}
const lengthOf = items => items.reduce((n,c) => Math.max(n,c.at+duration(c)),0)
let span = 1
function format(t){
  const ms = Math.round(t * 1000)
  return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0')
}
function showTime(position, total){
  $('clock').textContent=format(position)+' / '+format(total)
  $('cursor').style.left=(100*position/span)+'%'
}
function stop() {
  cancelAnimationFrame(frame)
  showTime(0,lengthOf(arrangement()))
  sources.forEach(s => s.stop())
  sources = []
}
function remember() {
  stop()
  history.push({clips: clips.map(c => ({...c})), active})
  if (history.length > 30) history.shift()
}
function draw() {
  const canvas = document.querySelector('#editor canvas'), g = canvas.getContext('2d')
  const c = current(), data = c.buffer.getChannelData(0)
  g.clearRect(0,0,1000,120)
  g.fillStyle = '#394b32'
  g.fillRect(1000*(selection?.begin ?? c.begin)/c.buffer.duration,0,1000*((selection?.end ?? c.end)-(selection?.begin ?? c.begin))/c.buffer.duration,120)
  g.fillStyle = '#c5f16a'
  for(let x=0;x<1000;x++){
    const start=Math.floor(x*data.length/1000), width=Math.ceil(data.length/1000)
    let peak=0
    for(let j=start;j<Math.min(data.length,start+width);j+=Math.max(1,Math.floor(width/64))) peak=Math.max(peak,Math.abs(data[j]))
    g.fillRect(x,60-peak*57,1,Math.max(1,peak*114))
  }
}
function paintClip(bar,c){
  bar.style.left=(100*c.at/span)+'%'
  bar.style.width=(100*duration(c)/span)+'%'
  const canvas=bar.querySelector('canvas'), g=canvas.getContext('2d')
  const data=c.buffer.getChannelData(0), rate=c.buffer.sampleRate
  g.clearRect(0,0,canvas.width,canvas.height)
  g.fillStyle='#c5f16a'
  const samples=(c.end-c.begin)*rate/canvas.width
  for(let x=0;x<canvas.width;x++){
    let peak=0
    const first=Math.floor(c.begin*rate+x*samples)
    const last=Math.min(data.length,Math.ceil(first+samples))
    for(let j=first;j<last;j+=Math.max(1,Math.floor(samples/32)))peak=Math.max(peak,Math.abs(data[j]))
    g.fillRect(x,22-peak*22,1,Math.max(1,peak*44))
  }
}
function renderTimeline(items){
  const zoom=Number($('zoom').value), timeline=$('timeline')
  timeline.style.width=(100*zoom)+'%'
  const ruler=$('ruler')
  ruler.replaceChildren()
  const ticks=Math.max(1,Math.floor(timeline.clientWidth/100))
  for(let i=0;i<ticks;i++){
    const tick=document.createElement('span')
    tick.textContent=format(span*i/ticks)
    tick.style.left=(100*i/ticks)+'%'
    ruler.append(tick)
  }
  $('range').textContent=''
  $('lanes').replaceChildren()
  items.forEach((clip,index)=>{
    const lane=document.createElement('div'),bar=document.createElement('button')
    const label=document.createElement('span'),canvas=document.createElement('canvas')
    label.textContent=clip.name
    canvas.width=800
    canvas.height=44
    bar.append(label,canvas)
    for(const edge of ['left','right']){
      const handle=document.createElement('i')
      handle.dataset.edge=edge
      bar.append(handle)
    }
    bar.setAttribute('aria-pressed',index===active)
    lane.append(bar)
    $('lanes').append(lane)
    paintClip(bar,clip)
    bar.onclick=e=>{if(e.detail===0){active=index;render()}}
    bar.onpointerdown=e=>{
      if(e.button!==0 || !e.isPrimary)return
      const edge=e.target.dataset.edge, origin=e.clientX
      const scale=span/timeline.getBoundingClientRect().width
      let draft={...clip}, moved=false
      bar.setPointerCapture(e.pointerId)
      function update(event){
        const dx=event.clientX-origin
        if(!moved && Math.abs(dx)<2)return
        if(!moved)stop()
        moved=true
        const delta=Math.round(dx*scale*1000)/1000
        const minimum=1/clip.buffer.sampleRate
        if(edge==='left'){
          const shift=Math.max(-clip.at,-clip.begin/clip.speed,Math.min(delta,duration(clip)-minimum/clip.speed))
          draft.begin=clip.begin+shift*clip.speed
          draft.at=clip.at+shift
        }else if(edge==='right'){
          draft.end=Math.max(clip.begin+minimum,Math.min(clip.buffer.duration,clip.end+delta*clip.speed))
        }else draft.at=Math.max(0,clip.at+delta)
        paintClip(bar,draft)
        $('range').textContent=format(draft.at)+' – '+format(draft.at+duration(draft))
      }
      bar.onpointermove=update
      bar.onpointercancel=()=>render()
      bar.onpointerup=event=>{
        update(event)
        if(moved){
          remember()
          items.forEach((item,i)=>{clips[i].offset=item.at})
          Object.assign(clips[index],{begin:draft.begin,end:draft.end,offset:draft.at})
        }
        active=index
        render()
      }
    }
  })
}
$('zoom').onchange=render
function render(){
  selection=null
  drag=null
  $('trim').disabled=true
  const items=arrangement(), total=lengthOf(items)
  span=Math.max(0.01,total*1.25)
  if(!sources.length) showTime(0,total)
  renderTimeline(items)
  const list=$('list')
  list.replaceChildren()
  clips.forEach((c,i)=>{
    const row=document.createElement('li')
    function button(label,action,disabled=false){
      const b=document.createElement('button')
      b.textContent=label
      b.disabled=disabled
      b.onclick=()=>{action();render()}
      row.append(b)
      return b
    }
    button((i+1)+'. '+c.name,()=>{active=i}).setAttribute('aria-pressed',i===active)
    function move(to){remember(); clips.splice(to,0,clips.splice(i,1)[0]); active=to}
    button('↑',()=>move(i-1),i===0)
    button('↓',()=>move(i+1),i===clips.length-1)
    button('Usuń',()=>{remember();clips.splice(i,1);active=Math.max(0,Math.min(i,clips.length-1))})
    list.append(row)
  })
  $('editor').hidden=!clips.length
  if(!clips.length) list.textContent='Brak klipów'
  else {
    for(const key of ['begin','end','speed','volume']) $(key).value=current()[key]
    $('offset').value=current().offset ?? ''
    draw()
  }
  $('play').disabled=$('save').disabled=!clips.length
  $('undo').disabled=!history.length
}
$('files').onchange=async e=>{
  const input=e.target, files=[...input.files], errors=[]
  input.disabled=true
  try {
    context ??= new AudioContext()
    for(const file of files){
      try{
        const buffer=await context.decodeAudioData(await file.arrayBuffer())
        remember()
        active=clips.push({buffer,name:file.name,begin:0,end:buffer.duration,speed:1,volume:100})-1
        render()
      }catch{errors.push(file.name)}
    }
    $('message').textContent=errors.length?'Nie można odczytać: '+errors.join(', '):''
  }finally{input.value='';input.disabled=false}
}
for(const key of ['begin','end','speed','volume']) $(key).onchange=()=>{
  const c={...current(),[key]:Number($(key).value)}
  if($(key).value && c.begin>=0 && c.end<=c.buffer.duration && c.end>c.begin && c.volume>=0 && c.volume<=100){
    remember();clips[active]=c;$('message').textContent=''
  }else $('message').textContent='Sprawdź zakres wartości.'
  render()
}
$('offset').onchange=()=>{
  const field=$('offset')
  if(field.validity.valid){
    remember()
    current().offset=field.value==='' ? null : field.valueAsNumber
  }
  render()
}
const wave=document.querySelector('#editor canvas')
function timeAt(e){
  const box=wave.getBoundingClientRect()
  return Math.max(0,Math.min(1,(e.clientX-box.left)/box.width))*current().buffer.duration
}
wave.onpointerdown=e=>{
  if(e.button!==0 || !e.isPrimary)return
  drag=timeAt(e)
  wave.setPointerCapture(e.pointerId)
  selection=null
  $('trim').disabled=true
  draw()
}
function selectRange(e){
  if(drag==null || !e.isPrimary)return
  const t=timeAt(e)
  selection={begin:Math.min(t,drag),end:Math.max(t,drag)}
  $('trim').disabled=selection.end-selection.begin<1/current().buffer.sampleRate
  draw()
}
wave.onpointermove=selectRange
wave.onpointerup=e=>{selectRange(e);drag=null}
wave.onpointercancel=()=>{drag=null;selection=null;$('trim').disabled=true;draw()}
$('trim').onclick=()=>{
  remember()
  Object.assign(current(),selection)
  render()
}
$('undo').onclick=()=>{stop();({clips,active}=history.pop());render()}
function schedule(ctx,items,start){
  const nodes=[]
  for(const c of items){
    const s=ctx.createBufferSource(), gain=ctx.createGain()
    s.buffer=c.buffer;s.playbackRate.value=c.speed;gain.gain.value=c.volume/100
    s.connect(gain).connect(ctx.destination)
    s.start(start+c.at,c.begin,c.end-c.begin)
    nodes.push(s)
  }
  return nodes
}
async function play(items, origin=0){
  await context.resume()
  stop()
  const start=context.currentTime+.04, length=lengthOf(items), total=lengthOf(arrangement())
  sources=schedule(context,items,start)
  function tick(){
    const t=Math.max(0,context.currentTime-start)
    showTime(origin+Math.min(t,length),total)
    if(t<length) frame=requestAnimationFrame(tick)
    else sources=[]
  }
  tick()
}
$('play').onclick=()=>play(arrangement())
$('preview').onclick=()=>{
  const c=arrangement()[active]
  play([{...c,at:0}],c.at)
}
$('stop').onclick=stop
$('save').onclick=async()=>{
  try{
    const rate=context.sampleRate, items=arrangement(), seconds=lengthOf(items)
    const offline=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate)
    schedule(offline,items,0)
    const buffer=await offline.startRendering(), size=buffer.length*4
    const bytes=new ArrayBuffer(44+size), v=new DataView(bytes)
    function tag(i,s){for(const ch of s)v.setUint8(i++,ch.charCodeAt(0))}
    tag(0,'RIFF');v.setUint32(4,36+size,true);tag(8,'WAVE');tag(12,'fmt ')
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true)
    v.setUint32(24,rate,true);v.setUint32(28,rate*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true)
    tag(36,'data');v.setUint32(40,size,true)
    for(let ch=0;ch<2;ch++){
      const data=buffer.getChannelData(ch)
      for(let i=0;i<data.length;i++)v.setInt16(44+i*4+2*ch,Math.max(-1,Math.min(1,data[i]))*32767,true)
    }
    const a=document.createElement('a')
    a.href=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));a.download='mixlab.wav';a.click()
    setTimeout(()=>URL.revokeObjectURL(a.href),30000)
  }catch{$('message').textContent='Eksport nie powiódł się. Spróbuj skrócić miks.'}
}
render()
