import {effects, effectBuffer} from './effects.js'
import {estimateBpm} from './bpm.js'
import {duration, transitions, transitionGain, fadeScale, envelope, prepare, schedule} from './audio.js'
const $ = id => document.getElementById(id)
let clips = [], history = [], active = 0, context, sources = []
const current = () => clips[active]
let frame, selection, drag
let future=[], cursor=0, loopRange=null, revision=0, nextTrack=1
function arrangement(){
  let next = 0
  const items=clips.map((c,index) => {
    const at = c.offset ?? next
    next = at + duration(c)
    return {...c, at, index}
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
let updateLiveMute = null
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
  updateLiveMute=null
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
  recordEdit()
}
function recordEdit() {
  history.push(snapshot())
  future=[]
  if (history.length > 30) history.shift()
}
function draw() {
  const canvas = document.querySelector('#editor canvas'), g = canvas.getContext('2d')
  const c = current(), data = c.buffer.getChannelData(0)
  g.clearRect(0,0,1000,120)
  g.fillStyle = '#30445b'
  g.fillRect(1000*(selection?.begin ?? c.begin)/c.buffer.duration,0,1000*((selection?.end ?? c.end)-(selection?.begin ?? c.begin))/c.buffer.duration,120)
  g.fillStyle = '#a6d5e9'
  for(let x=0;x<1000;x++){
    const start=Math.floor(x*data.length/1000), width=Math.ceil(data.length/1000)
    let peak=0
    for(let j=start;j<Math.min(data.length,start+width);j+=Math.max(1,Math.floor(width/64))) peak=Math.max(peak,Math.abs(data[j]))
    g.fillRect(x,60-peak*57,1,Math.max(1,peak*114))
  }
}
let mode = 'move'
const hints = {
  move: 'Przeciągnij klip wzdłuż osi lub na inną ścieżkę.',
  trim: 'Przeciągnij lewą lub prawą krawędź klipu, aby go przyciąć.',
  stretch: 'Przeciągnij krawędź klipu, aby zmienić tempo.',
  attack: 'Kliknij na fali moment, w którym wejście ma osiągnąć pełną głośność. Przesuń miętowy punkt, aby go dopasować.',
  fade: 'Kliknij na fali początek wyciszenia. Przesuń złoty punkt, aby go dopasować.'
}
function selectMode(value) {
  mode = value
  $('timeline').dataset.mode = mode
  $('hint').textContent = hints[mode]
  for (const button of $('modes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed',button.dataset.mode === mode)
  }
}
for (const button of $('modes').querySelectorAll('button')) {
  button.onclick = () => selectMode(button.dataset.mode)
}
selectMode(mode)

function showFormats(open) {
  $('formats').hidden = !open
  $('exportMenu').setAttribute('aria-expanded',open)
}
$('exportMenu').onclick = () => showFormats($('formats').hidden)
document.addEventListener('click', event => {
  if (!event.target.closest('.exports')) showFormats(false)
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('formats').hidden) {
    showFormats(false)
    $('exportMenu').focus()
  }
})

function editFadePoint(event, bar, clip, index, key, marker) {
  const width = bar.getBoundingClientRect().width
  const left = bar.getBoundingClientRect().left
  const length = duration(clip)
  const scale = fadeScale(clip)
  const inward = key === 'fadeIn'
  const start = inward ? clip.fadeIn * scale : length - clip.fadeOut * scale
  const description = inward ? 'Koniec narastania ' : 'Początek wyciszenia '
  const draft = {...clip}
  let point = start
  bar.setPointerCapture(event.pointerId)
  function preview(x) {
    const time = marker ? start + (x-event.clientX)*length/width : (x-left)*length/width
    point = Math.max(0,Math.min(length,Math.round(time*1000)/1000))
    draft.fadeIn = inward ? point : Math.min(clip.fadeIn*scale,point)
    draft.fadeOut = inward ? Math.min(clip.fadeOut*scale,length-point) : length-point
    paintClip(bar,draft)
    $('range').textContent = description+format(clip.at+point)+' · długość '+format(draft[key])
  }
  function finish() {
    bar.onpointermove = bar.onpointerup = bar.onpointercancel = null
    render()
  }
  if (!marker) preview(event.clientX)
  bar.onpointermove = e => {if(e.pointerId===event.pointerId) preview(e.clientX)}
  bar.onpointercancel = finish
  bar.onpointerup = e => {
    if(e.pointerId!==event.pointerId)return
    if(!marker || e.clientX!==event.clientX) preview(e.clientX)
    if(draft.fadeOut!==clip.fadeOut || draft.fadeIn!==clip.fadeIn) {
      remember()
      clips[index].fadeIn = draft.fadeIn
      clips[index].fadeOut = draft.fadeOut
    }
    active = index
    finish()
    $('range').textContent = description+format(clip.at+point)+' · długość '+format(draft[key])
  }
}
function tempoLabel(c){
  return c.sourceBpm ? mixBpm(c)+' BPM' : Number((100*c.speed).toFixed(2))+'%'
}

function makeClipControls(c,index){
  const dock=document.createElement('div')
  dock.className='clip-dock'
  const tools=document.createElement('div')
  tools.className='clip-tools'
  tools.setAttribute('role','group')
  tools.setAttribute('aria-label','Sterowanie klipem '+c.name)
  const tempo=document.createElement('span')
  tempo.className='clip-tempo'
  tempo.title=c.sourceBpm ? 'Tempo w miksie' : 'Prędkość odtwarzania · nieznane BPM'
  tools.append(tempo)
  function control(text,title,action){
    const button=document.createElement('button')
    button.textContent=text
    button.title=title
    button.setAttribute('aria-label',title+' · '+c.name)
    button.onclick=()=>{
      action()
      active=index
      render()
      const replacement=$('lanes').querySelectorAll('.clip-tools')[index]?.querySelector('[data-action="'+button.dataset.action+'"]')
      if(replacement && !replacement.disabled) replacement.focus({preventScroll:true})
    }
    tools.append(button)
    return button
  }
  for(const direction of [-1,1]){
    const change=direction/(c.sourceBpm || 100)
    const speed=Math.max(.25,Math.min(4,Number((c.speed+change).toFixed(12))))
    const unit=c.sourceBpm ? '1 BPM' : '1 punkt procentowy'
    const title=(direction>0 ? 'Zwiększ' : 'Zmniejsz')+' tempo o '+unit
    const button=control(direction>0 ? '+' : '−',title,()=>{
      remember()
      clips[index].speed=speed
    })
    button.dataset.action=direction>0 ? 'faster' : 'slower'
    button.disabled=speed===c.speed
  }
  const mute=control(c.muted ? 'Włącz' : 'Wycisz',c.muted ? 'Włącz dźwięk klipu' : 'Wycisz dźwięk klipu',()=>{
    recordEdit()
    clips[index].muted=!clips[index].muted
    updateLiveMute?.(index,clips[index].muted)
  })
  mute.dataset.action='mute'
  mute.setAttribute('aria-pressed',Boolean(c.muted))
  dock.append(tools)
  return dock
}

function paintClip(bar,c){
  const slot=bar.parentElement
  slot.style.setProperty('--at',(100*c.at/span)+'%')
  slot.style.setProperty('--duration',(100*duration(c)/span)+'%')
  slot.querySelector('.clip-tempo').textContent=tempoLabel(c)
  const canvas=bar.querySelector('canvas'), g=canvas.getContext('2d')
  const data=c.buffer.getChannelData(0), rate=c.buffer.sampleRate
  g.clearRect(0,0,canvas.width,canvas.height)
  const length=duration(c)
  const scale=fadeScale(c)
  for(const marker of bar.querySelectorAll('[data-fade]')){
    const inward=marker.dataset.fade==='fadeIn'
    const fraction=c[marker.dataset.fade]*scale/length
    const boundary=inward ? fraction : 1-fraction
    marker.hidden=fraction<=0
    marker.style.left=(100*boundary)+'%'
    marker.title=(inward ? 'Koniec narastania ' : 'Początek wyciszenia ')+format(c.at+length*boundary)
    g.fillStyle=inward ? '#81dfc433' : '#ffcd6a22'
    g.fillRect(inward ? 0 : boundary*canvas.width,0,fraction*canvas.width,44)
  }
  g.fillStyle='#d5e9f2'
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
    const xStart=canvas.width*tr.start/length
    const width=canvas.width*tr.length/length
    g.fillRect(xStart,0,width,44)
    g.beginPath()
    for(let step=0;step<=32;step++){
      const phase=step/32
      const gain=transitionGain(phase,!tr.inward,tr.linear)
      g.lineTo(xStart+phase*width,42-40*gain)
    }
    g.strokeStyle='#ffe5a7aa'
    g.lineWidth=1.5
    g.stroke()
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
  const timelineWidth=Math.max(1,timeline.clientWidth)
  const controlDuration=parseFloat(getComputedStyle(timeline).getPropertyValue('--controls-width'))*span/timelineWidth
  const ideal=Math.max(.001,span*77/timelineWidth)
  const magnitude=10**Math.floor(Math.log10(ideal))
  const step=magnitude*[1,2,5,10].find(n=>n*magnitude>=ideal)
  timeline.style.setProperty('--grid',(100*step/span)+'%')
  ruler.style.setProperty('--minor',(100*Math.max(.001,step/10)/span)+'%')
  for(let i=0;i*step<span;i++){
    const tick=document.createElement('span')
    tick.textContent=format(i*step)
    tick.style.left=(100*i*step/span)+'%'
    ruler.append(tick)
  }
  refreshRulerHover()
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
    const dockStart=Math.max(0,Math.min(clip.at,span-controlDuration))
    let row=ends.findIndex(end=>end<=dockStart)
    if(row<0)row=ends.length
    ends[row]=Math.max(clip.at+duration(clip),dockStart+controlDuration)
    const slot=document.createElement('div')
    slot.className='clip-slot'
    slot.classList.toggle('muted',Boolean(clip.muted))
    const bar=document.createElement('button')
    const label=document.createElement('span'),canvas=document.createElement('canvas')
    label.textContent=clip.name
    bar.className='wave-clip'
    bar.dataset.color=index%4
    canvas.width=800
    canvas.height=44
    bar.append(label,canvas)
    for(const edge of ['left','right','fadeIn','fadeOut']){
      const handle=document.createElement('i')
      handle.dataset.edge=edge
      handle.title=({left:'Lewa krawędź',right:'Prawa krawędź',fadeIn:'Narastanie',fadeOut:'Wygaszanie'})[edge]
      bar.append(handle)
    }
    for(const key of ['fadeIn','fadeOut']){
      const marker=document.createElement('i')
      marker.className=key==='fadeIn' ? 'fade-end' : 'fade-start'
      marker.dataset.fade=key
      bar.append(marker)
    }
    bar.setAttribute('aria-pressed',index===active)
    slot.append(bar,makeClipControls(clip,index))
    lane.append(slot)
    slot.style.top=(23+row*96)+'px'
    lane.style.height=(25+ends.length*96)+'px'
    paintClip(bar,clip)
    bar.onclick=e=>{if(e.detail===0){active=index;render()}}
    bar.onpointerdown=e=>{
      if(e.button!==0 || !e.isPrimary)return
      const edge=e.target.dataset.edge, origin=e.clientX
      const marker=e.target.dataset.fade
      const fadeKey=mode==='attack' ? 'fadeIn' : mode==='fade' ? 'fadeOut' : marker
      if(fadeKey) {
        editFadePoint(e,bar,clip,index,fadeKey,marker===fadeKey)
        return
      }
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
            if(slot.parentElement!==target){target.append(slot);bar.setPointerCapture(e.pointerId)}
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
  $('bpmStatus').textContent=''
  selection=null
  drag=null
  $('trim').disabled=true
  const items=arrangement(), total=lengthOf(items)
  span=total ? Math.max(0.01,total*1.25) : 30
  $('clipList').hidden=!clips.length
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
    $('sourceBpm').value=current().sourceBpm ?? ''
    $('targetBpm').disabled=!current().sourceBpm
    $('targetBpm').value=current().sourceBpm ? mixBpm(current()) : ''
    $('attackCurve').value=current().attackCurve ?? 'linear'
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
function addClip(buffer,name,sourceBpm,offset) {
  remember()
  active=clips.push({
    buffer,name,sourceBpm,offset,track:nextTrack++,preserve:true,curve:'equal',
    begin:0,end:buffer.duration,speed:1,volume:100,fadeIn:0,fadeOut:0
  })-1
  render()
}

const effectsDialog=$('effectsDialog')
let audition=null, effectPosition=0
function stopAudition(){
  if(!audition)return
  const {node,button}=audition
  audition=null
  node.onended=null
  node.stop()
  node.disconnect()
  button.textContent='▶'
  button.setAttribute('aria-pressed','false')
}
$('openEffects').onclick=()=>{
  effectPosition=displayedTime
  cursor=effectPosition
  stop()
  $('effectTime').textContent=format(effectPosition)
  $('effectStatus').textContent=''
  effectsDialog.showModal()
}
function closeEffects(){
  stopAudition()
  effectsDialog.close()
}
$('closeEffects').onclick=closeEffects
effectsDialog.oncancel=stopAudition
for(const effect of effects){
  const row=document.createElement('div')
  const name=document.createElement('span')
  const preview=document.createElement('button')
  const add=document.createElement('button')
  name.textContent=effect.name
  preview.textContent='▶'
  preview.setAttribute('aria-label','Odsłuch: '+effect.name)
  preview.setAttribute('aria-pressed','false')
  preview.onclick=async()=>{
    const toggledOff=audition?.button===preview
    stopAudition()
    if(toggledOff)return
    context ??= new AudioContext()
    const node=context.createBufferSource()
    node.buffer=effectBuffer(context,effect)
    node.connect(context.destination)
    audition={node,button:preview}
    node.onended=()=>{
      node.disconnect()
      if(audition?.node===node){
        audition=null
        preview.textContent='▶'
        preview.setAttribute('aria-pressed','false')
      }
    }
    preview.textContent='■'
    preview.setAttribute('aria-pressed','true')
    node.start()
    try{await context.resume()}
    catch{
      if(audition?.node===node){
        stopAudition()
        $('effectStatus').textContent='Nie udało się uruchomić odsłuchu.'
      }
    }
  }
  add.textContent='Dodaj'
  add.setAttribute('aria-label','Dodaj: '+effect.name)
  add.onclick=()=>{
    closeEffects()
    context ??= new AudioContext()
    addClip(effectBuffer(context,effect),effect.name,null,effectPosition)
    $('message').textContent='Dodano '+effect.name+' w '+format(effectPosition)+'.'
  }
  row.append(preview,name,add)
  $('effectList').append(row)
}
$('files').onchange=async e=>{
  const input=e.target, files=[...input.files], errors=[]
  input.disabled=true
  try {
    context ??= new AudioContext()
    for(const file of files){
      try{
        const buffer=await context.decodeAudioData(await file.arrayBuffer())
        addClip(buffer,file.name,estimateBpm(buffer))
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
function mixBpm(clip){
  return Number((clip.sourceBpm*clip.speed).toFixed(3))
}
function setSourceBpm(value){
  remember()
  current().sourceBpm=value
  render()
}
$('estimateBpm').onclick=()=>{
  const value=estimateBpm(current().buffer)
  if(value) setSourceBpm(value)
  $('bpmStatus').textContent=value ? 'Szacowane tempo: '+value+' BPM.' : 'Brak wyraźnego pulsu. Wpisz BPM źródłowe ręcznie.'
}
$('sourceBpm').onchange=()=>{
  const field=$('sourceBpm')
  if(!field.validity.badInput && (field.value==='' || field.valueAsNumber>0)){
    setSourceBpm(field.value==='' ? null : field.valueAsNumber)
  }else{
    render()
    $('bpmStatus').textContent='Podaj dodatnie BPM źródłowe.'
  }
}
$('targetBpm').onchange=()=>{
  const original=current().sourceBpm
  const speed=$('targetBpm').valueAsNumber/original
  if(speed>=0.25 && speed<=4){
    remember()
    current().speed=speed
    render()
  }else{
    render()
    $('bpmStatus').textContent='BPM docelowe musi mieścić się w zakresie od '+original/4+' do '+original*4+'.'
  }
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
for(const key of ['preserve','curve','attackCurve','crossLength']) $(key).onchange=()=>{
  const field=$(key)
  if(!field.validity.valid){render();return}
  remember()
  current()[key]=key==='preserve' ? field.checked : key!=='crossLength' ? field.value : field.value==='' ? null : field.valueAsNumber
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
let rulerPointer=null
function refreshRulerHover(){
  const guide=$('hoverGuide'), label=$('hoverTime')
  guide.hidden=label.hidden=rulerPointer===null
  if(guide.hidden)return
  const box=$('ruler').getBoundingClientRect()
  const viewport=$('ruler').closest('.timeline-scroll').getBoundingClientRect()
  const x=Math.max(0,Math.min(box.width,rulerPointer-box.left))
  guide.style.left=x+'px'
  label.textContent=format(span*x/box.width)
  const maxLeft=viewport.right-box.left-label.offsetWidth
  label.style.left=Math.max(viewport.left-box.left,Math.min(x+5,maxLeft))+'px'
}
function trackRuler(event){
  rulerPointer=event.clientX
  refreshRulerHover()
}
function hideGuide(){
  rulerPointer=null
  refreshRulerHover()
}
for(const type of ['pointerenter','pointermove','pointerdown']) $('ruler').addEventListener(type,trackRuler)
$('ruler').addEventListener('pointerleave',hideGuide)
$('ruler').addEventListener('pointercancel',hideGuide)
$('ruler').addEventListener('pointerup',event=>{if(event.pointerType!=='mouse')hideGuide()})
document.querySelector('.timeline-scroll').addEventListener('scroll',refreshRulerHover)
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
    let start
    const total=lengthOf(arrangement())
    // Mute can change while pitch-preserving audio is being prepared.
    for(const c of items)c.muted=clips[c.index].muted
    function begin(){
      playbackMode=mode
      updatePause()
      tick()
    }
    if(repeat){
      // Keep the current loop sounding while rendering a replacement. Swap at
      // the same phase of the audio clock, including when playback is paused.
      let building=false, dirty=false
      async function refreshLoop(){
        dirty=true
        if(building)return
        building=true
        try{
          while(dirty && token===revision){
            dirty=false
            const offline=new OfflineAudioContext(2,Math.ceil(length*context.sampleRate),context.sampleRate)
            schedule(offline,items,0,from,to)
            const buffer=await offline.startRendering()
            if(dirty || token!==revision)continue
            const when=Math.max(start ?? 0,context.currentTime+.02)
            const first=start===undefined
            if(first)start=when
            const node=context.createBufferSource()
            node.buffer=buffer
            node.loop=true
            node.connect(context.destination)
            node.start(when,(when-start)%length)
            sources.forEach(s=>s.stop(when))
            sources=[node]
            if(first)begin()
          }
        }catch{
          if(token===revision){stop();$('message').textContent='Nie udało się przygotować pętli.'}
        }finally{building=false}
      }
      updateLiveMute=(index,muted)=>{
        const clip=items.find(c=>c.index===index)
        if(clip){clip.muted=muted;refreshLoop()}
      }
      await refreshLoop()
    }else{
      const gates=new Map()
      start=context.currentTime+.04
      sources=schedule(context,items,start,from,to,(gain,c)=>{
        const gate=context.createGain()
        gate.gain.value=c.muted ? 0 : 1
        gain.connect(gate).connect(context.destination)
        gates.set(c.index,gate)
      })
      updateLiveMute=(index,muted)=>{
        const gate=gates.get(index)
        if(gate)gate.gain.setTargetAtTime(muted ? 0 : 1,context.currentTime,.003)
      }
      begin()
    }
    function tick(){
      const t=Math.max(0,context.currentTime-start)
      showTime(origin+from+(repeat?t%length:Math.min(t,length)),total)
      if(repeat || t<length)frame=requestAnimationFrame(tick)
      else {sources=[];playbackMode=null;updateLiveMute=null;updatePause()}
    }
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
  $('exportMenu').disabled=$('save').disabled=$('mp3').disabled=exporting || !clips.length
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
  showFormats(false)
  exporting=true
  updateExports()
  $('message').textContent='Trwa eksport '+format.toUpperCase()+'…'
  try{
    const rate=format==='mp3' ? 44100 : context.sampleRate, items=arrangement(), seconds=lengthOf(items)
    const offline=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate)
    await prepare(items.filter(c=>!c.muted))
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

const viewport=document.querySelector('.timeline-scroll')
let viewportWidth=viewport.clientWidth
new ResizeObserver(()=>{
  if(viewport.clientWidth===viewportWidth)return
  viewportWidth=viewport.clientWidth
  renderTimeline(arrangement())
}).observe(viewport)
