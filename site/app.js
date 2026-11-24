import {duration, transitions, envelope, prepare, schedule} from './audio.js'
const $ = id => document.getElementById(id)
let clips = [], history = [], active = 0, context, sources = []
const current = () => clips[active]
let frame, selection, drag
let future=[], cursor=0, loopRange=null, revision=0, nextTrack=1
function arrangement(){
  let next = 0
  const items=clips.map(c => {
    const at = c.offset ?? next
    next = at + duration(c)
    return {...c, at}
  })
  transitions(items,$('auto').checked)
  return items
}
const lengthOf = items => items.reduce((n,c) => Math.max(n,c.at+duration(c)),0)
let span = 1, displayedTime = 0
function format(t){
  const ms = Math.round(t * 1000)
  return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0')
}
function showTime(position, total){
  displayedTime=position
  $('clock').textContent=format(position)+' / '+format(total)
  $('cursor').style.left=(100*position/span)+'%'
}
let playbackMode = null
let exporting = false
function updatePause(){
  for(const mode of ['Clip','Mix']){
    const button=$('pause'+mode)
    button.disabled=playbackMode!==mode
    button.textContent=playbackMode===mode && context.state==='suspended' ? 'Wznów' : 'Pauza'
  }
}
function stop() {
  revision++
  playbackMode=null
  updatePause()
  cancelAnimationFrame(frame)
  showTime(cursor,lengthOf(arrangement()))
  sources.forEach(s => s.stop())
  sources = []
}
function snapshot(){return {clips:clips.map(c=>({...c})),active,auto:$('auto').checked}}
function remember() {
  stop()
  history.push(snapshot())
  future=[]
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
  for(const tr of c.transitions ?? []){
    g.fillStyle='#a480ff55'
    g.fillRect(canvas.width*tr.start/duration(c),0,canvas.width*tr.length/duration(c),44)
  }
  g.beginPath()
  for(let x=0;x<=canvas.width;x+=4){
    g.lineTo(x,42-40*envelope(c,duration(c)*x/canvas.width))
  }
  g.strokeStyle='#ffde8c'
  g.lineWidth=2
  g.stroke()
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
  const lanes=new Map()
  for(const track of [...new Set([...items.map(c=>c.track),nextTrack])].sort((a,b)=>a-b)){
    if(!items.length)break
    const lane=document.createElement('div')
    lane.dataset.track=track
    lane.dataset.name=track===nextTrack ? '+ Nowa ścieżka' : 'Ścieżka '+track
    lanes.set(track,{lane,ends:[]})
    $('lanes').append(lane)
  }
  items.forEach((clip,index)=>{
    const {lane,ends}=lanes.get(clip.track)
    let row=ends.findIndex(end=>end<=clip.at)
    if(row<0)row=ends.length
    ends[row]=clip.at+duration(clip)
    const bar=document.createElement('button')
    const label=document.createElement('span'),canvas=document.createElement('canvas')
    label.textContent=clip.name
    canvas.width=800
    canvas.height=44
    bar.append(label,canvas)
    for(const edge of ['left','right','fadeIn','fadeOut']){
      const handle=document.createElement('i')
      handle.dataset.edge=edge
      handle.title=({left:'Lewa krawędź',right:'Prawa krawędź',fadeIn:'Narastanie',fadeOut:'Wygaszanie'})[edge]
      bar.append(handle)
    }
    bar.setAttribute('aria-pressed',index===active)
    lane.append(bar)
    bar.style.top=(23+row*66)+'px'
    lane.style.height=(25+ends.length*66)+'px'
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
        if(!moved && Math.hypot(dx,event.clientY-e.clientY)<3)return
        if(!moved)stop()
        moved=true
        const delta=Math.round(dx*scale*1000)/1000
        const minimum=1/clip.buffer.sampleRate
        const mode=$('mode').value
        const side=edge || (origin < bar.getBoundingClientRect().left+bar.clientWidth/2 ? 'left' : 'right')
        if(edge==='fadeIn' || edge==='fadeOut'){
          draft[edge]=Math.max(0,Math.min(duration(clip),clip[edge]+delta*(edge==='fadeIn'?1:-1)))
        }else if(mode==='stretch'){
          const desired=duration(clip)+(side==='right'?delta:-delta)
          draft.speed=Math.max(.25,Math.min(4,(clip.end-clip.begin)/Math.max(.001,desired)))
          if(side==='left')draft.at=Math.max(0,clip.at+duration(clip)-duration(draft))
        }else if((edge || mode==='trim') && side==='left'){
          const shift=Math.max(-clip.at,-clip.begin/clip.speed,Math.min(delta,duration(clip)-minimum/clip.speed))
          draft.begin=clip.begin+shift*clip.speed
          draft.at=clip.at+shift
        }else if(edge || mode==='trim'){
          draft.end=Math.max(clip.begin+minimum,Math.min(clip.buffer.duration,clip.end+delta*clip.speed))
        }else{
          draft.at=Math.max(0,clip.at+delta)
          if($('snap').checked){
            const targets=items.filter((_,i)=>i!==index).flatMap(c=>[c.at,c.at+duration(c)])
            const distances=targets.flatMap(t=>[t-draft.at,t-draft.at-duration(clip)])
            const nearest=distances.sort((a,b)=>Math.abs(a)-Math.abs(b))[0]
            if(Math.abs(nearest)<=8*scale)draft.at=Math.max(0,draft.at+nearest)
          }
          const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-track]')
          if(target){
            draft.track=Number(target.dataset.track)
            if(bar.parentElement!==target){target.append(bar);bar.setPointerCapture(e.pointerId)}
          }
        }
        paintClip(bar,draft)
        $('range').textContent=format(draft.at)+' – '+format(draft.at+duration(draft))+' · długość '+format(duration(draft))
      }
      bar.onpointermove=update
      bar.onpointercancel=()=>render()
      bar.onpointerup=event=>{
        update(event)
        if(moved){
          remember()
          items.forEach((item,i)=>{clips[i].offset=item.at})
          Object.assign(clips[index],{begin:draft.begin,end:draft.end,offset:draft.at,speed:draft.speed,track:draft.track,fadeIn:draft.fadeIn,fadeOut:draft.fadeOut})
        }
        nextTrack=Math.max(nextTrack,draft.track+1)
        active=index
        if(!moved && (edge==='fadeIn' || edge==='fadeOut')){
          remember()
          clips[index][edge]=clips[index][edge] ? 0 : Math.min(1,duration(clip))
        }
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
  cursor=Math.min(cursor,total)
  if(!sources.length) showTime(cursor,total)
  paintLoop()
  renderTimeline(items)
  const list=$('list')
  list.replaceChildren()
  clips.forEach((c,i)=>{
    const row=document.createElement('li')
    function button(label,action,disabled=false){
      const b=document.createElement('button')
      b.textContent=label
      if(label==='↑')b.title='Przenieś wcześniej na liście'
      if(label==='↓')b.title='Przenieś później na liście'
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
    for(const key of ['begin','end','speed','volume','fadeIn','fadeOut']) $(key).value=current()[key]
    $('speed').value=Number((current().speed*100).toFixed(3))
    $('preserve').checked=current().preserve
    $('curve').value=current().curve
    $('crossLength').value=current().crossLength ?? ''
    $('properties').textContent=current().name
    $('length').textContent='Długość '+format(duration(current()))
    $('offset').value=current().offset ?? ''
    draw()
  }
  $('play').disabled=!clips.length
  updateExports()
  $('redo').disabled=!future.length
  $('split').disabled=!clips.length
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
        active=clips.push({buffer,track:nextTrack++,preserve:true,curve:'equal',name:file.name,begin:0,end:buffer.duration,speed:1,volume:100,fadeIn:0,fadeOut:0})-1
        render()
      }catch{errors.push(file.name)}
    }
    $('message').textContent=errors.length?'Nie można odczytać: '+errors.join(', '):''
  }finally{input.value='';input.disabled=false}
}
for(const key of ['begin','end','speed','volume','fadeIn','fadeOut']) $(key).onchange=()=>{
  const c={...current(),[key]:Number($(key).value)}
  if(key==='speed')c.speed/=100
  if(c.speed>=.25 && c.speed<=4 && $(key).value && c.begin>=0 && c.end<=c.buffer.duration && c.end>c.begin && c.volume>=0 && c.volume<=100 && c.fadeIn>=0 && c.fadeOut>=0){
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
function restore(stack,other){
  if(!stack.length)return
  stop()
  other.push(snapshot())
  const state=stack.pop()
  clips=state.clips
  active=state.active
  $('auto').checked=state.auto
  render()
}
$('undo').onclick=()=>restore(history,future)
$('redo').onclick=()=>restore(future,history)
$('auto').onchange=()=>{
  $('auto').checked=!$('auto').checked
  remember()
  $('auto').checked=!$('auto').checked
  render()
}
for(const key of ['preserve','curve','crossLength']) $(key).onchange=()=>{
  const field=$(key)
  if(!field.validity.valid){render();return}
  remember()
  current()[key]=key==='preserve' ? field.checked : key==='curve' ? field.value : field.value==='' ? null : field.valueAsNumber
  render()
}
function paintLoop(){
  const band=$('loopBand')
  band.hidden=!loopRange || !$('loop').checked
  if(loopRange){
    band.style.left=100*loopRange[0]/span+'%'
    band.style.width=100*(loopRange[1]-loopRange[0])/span+'%'
  }
}
$('loop').onchange=()=>{stop();paintLoop()}
$('ruler').onpointerdown=e=>{
  if(!clips.length || e.button!==0)return
  stop()
  const ruler=$('ruler'), box=ruler.getBoundingClientRect(), total=lengthOf(arrangement())
  const time=x=>Math.min(total,Math.max(0,(x-box.left)*span/box.width))
  const first=time(e.clientX)
  cursor=first
  showTime(cursor,total)
  ruler.setPointerCapture(e.pointerId)
  function update(event){
    if(Math.abs(event.clientX-e.clientX)<3)return
    const last=time(event.clientX)
    loopRange=[Math.min(first,last),Math.max(first,last)]
    $('loop').checked=true
    paintLoop()
  }
  ruler.onpointermove=update
  ruler.onpointerup=event=>{update(event);ruler.onpointermove=null}
  ruler.onpointercancel=()=>{ruler.onpointermove=null}
}
$('split').onclick=()=>{
  const items=arrangement(), c=items[active]
  const cut=displayedTime
  const point=c.begin+(cut-c.at)*c.speed
  if(point<=c.begin || point>=c.end){$('message').textContent='Ustaw kursor wewnątrz wybranego klipu.';return}
  remember()
  items.forEach((item,i)=>{clips[i].offset=item.at})
  const right={...current(),begin:point,offset:cut,fadeIn:0}
  current().end=point
  current().fadeOut=0
  clips.splice(active+1,0,right)
  render()
}
async function play(mode,items,origin,from,to,repeat=false){
  stop()
  const token=revision
  try{
    await context.resume()
    await prepare(items)
    if(token!==revision)return
    const length=to-from
    if(length<=0)return
    let loopBuffer
    if(repeat){
      const offline=new OfflineAudioContext(2,Math.ceil(length*context.sampleRate),context.sampleRate)
      schedule(offline,items,0,from,to)
      loopBuffer=await offline.startRendering()
      if(token!==revision)return
    }
    playbackMode=mode
    updatePause()
    const start=context.currentTime+.04, total=lengthOf(arrangement())
    if(loopBuffer){
      const node=context.createBufferSource()
      node.buffer=loopBuffer
      node.loop=true
      node.connect(context.destination)
      node.start(start)
      sources=[node]
    }else sources=schedule(context,items,start,from,to)
    function tick(){
      const t=Math.max(0,context.currentTime-start)
      showTime(origin+from+(repeat?t%length:Math.min(t,length)),total)
      if(repeat || t<length)frame=requestAnimationFrame(tick)
      else {sources=[];playbackMode=null;updatePause()}
    }
    tick()
  }catch{$('message').textContent='Nie udało się przygotować odsłuchu.'}
}
$('play').onclick=()=>{
  const items=arrangement(),total=lengthOf(items)
  const repeat=$('loop').checked && loopRange && Math.min(total,loopRange[1])>loopRange[0]
  play('Mix',items,0,repeat?loopRange[0]:cursor<total?cursor:0,repeat?Math.min(total,loopRange[1]):total,repeat)
}
$('preview').onclick=()=>{
  const c=arrangement()[active]
  play('Clip',[{...c,at:0}],c.at,0,duration(c))
}
$('stop').onclick=stop
for(const mode of ['Clip','Mix']){
  $('pause'+mode).onclick=async()=>{
    if(playbackMode!==mode)return
    if(context.state==='running') await context.suspend()
    else await context.resume()
    updatePause()
  }
}
function updateExports(){
  $('save').disabled=$('mp3').disabled=exporting || !clips.length
}
function encodeMp3(buffer){
  const channels=[buffer.getChannelData(0).slice(),buffer.getChannelData(1).slice()]
  const worker=new Worker('mp3-worker.js')
  return new Promise((resolve,reject)=>{
    worker.onmessage=e=>resolve(e.data)
    worker.onerror=reject
    worker.postMessage({channels,rate:buffer.sampleRate},channels.map(c=>c.buffer))
  }).finally(()=>worker.terminate())
}
function encodeWav(buffer){
    const size=buffer.length*4, rate=buffer.sampleRate
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
    return new Blob([bytes],{type:'audio/wav'})
}
async function exportMix(format){
  exporting=true
  updateExports()
  $('message').textContent='Trwa eksport '+format.toUpperCase()+'…'
  try{
    const rate=format==='mp3' ? 44100 : context.sampleRate, items=arrangement(), seconds=lengthOf(items)
    const offline=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate)
    await prepare(items)
    schedule(offline,items,0,0,seconds)
    const buffer=await offline.startRendering()
    const blob=format==='mp3' ? await encodeMp3(buffer) : encodeWav(buffer)
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob);a.download='mixlab.'+format;a.click()
    $('message').textContent='Gotowe.'
    setTimeout(()=>URL.revokeObjectURL(a.href),30000)
  }catch{$('message').textContent='Eksport nie powiódł się. Spróbuj skrócić miks.'}
  finally{exporting=false;updateExports()}
}
$('save').onclick=()=>exportMix('wav')
$('mp3').onclick=()=>exportMix('mp3')
render()
