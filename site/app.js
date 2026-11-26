import {drawWave,paintSamples} from './waveform.js'
import {modelCached, deviceLimit, separateClip} from './stems.js'
import {effects, effectBuffer} from './effects.js'
import {estimateBpm} from './bpm.js'
import {duration, transitions, transitionGain, fadeScale, envelope, prepare, schedule, mixPeak} from './audio.js'
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
let updateLiveLevel = null
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
  updateLiveLevel=null
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
  const c=current(), dpr=devicePixelRatio || 1
  const width=Math.max(1,Math.round(canvas.clientWidth*dpr))
  const height=Math.max(1,Math.round(canvas.clientHeight*dpr))
  if(canvas.width!==width)canvas.width=width
  if(canvas.height!==height)canvas.height=height
  g.clearRect(0,0,width,height)
  g.fillStyle='#30445b'
  const begin=selection?.begin ?? c.begin, end=selection?.end ?? c.end
  g.fillRect(width*begin/c.buffer.duration,0,width*(end-begin)/c.buffer.duration,height)
  paintSamples(g,c.buffer,0,c.buffer.length/width)
}
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

function editFadePoint(event, bar, clip, index, key) {
  const width = bar.getBoundingClientRect().width
  const length = duration(clip)
  const scale = fadeScale(clip)
  const inward = key === 'fadeIn'
  const start = inward ? clip.fadeIn * scale : length - clip.fadeOut * scale
  const description = inward ? 'Koniec narastania ' : 'Początek wyciszenia '
  const draft = {...clip}
  let point = start
  bar.setPointerCapture(event.pointerId)
  function preview(x) {
    const time = start + (x-event.clientX)*length/width
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
  bar.onpointermove = e => {if(e.pointerId===event.pointerId) preview(e.clientX)}
  bar.onpointercancel = finish
  bar.onpointerup = e => {
    if(e.pointerId!==event.pointerId)return
    if(Math.abs(e.clientX-event.clientX)>=3){
      preview(e.clientX)
      if(draft.fadeOut!==clip.fadeOut || draft.fadeIn!==clip.fadeIn){
        remember()
        clips[index].fadeIn=draft.fadeIn
        clips[index].fadeOut=draft.fadeOut
      }
    }else{
      remember()
      const curve=inward ? 'attackCurve' : 'releaseCurve'
      clips[index][curve]=clips[index][curve]==='equal' ? 'linear' : 'equal'
    }
    active = index
    finish()
    $('range').textContent = description+format(clip.at+point)+' · '+(clips[index][inward ? 'attackCurve' : 'releaseCurve']==='equal' ? 'Equal Power' : 'Liniowa')
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
    updateLiveLevel?.(index)
  })
  mute.dataset.action='mute'
  mute.setAttribute('aria-pressed',Boolean(c.muted))
  const volumeRow=document.createElement('label')
  volumeRow.className='clip-volume'
  volumeRow.title='Głośność klipu'
  const slider=document.createElement('input')
  slider.type='range'
  slider.min=0
  slider.max=100
  slider.value=c.volume
  slider.setAttribute('aria-label','Głośność klipu '+c.name)
  const readout=document.createElement('span')
  function showLevel(value){
    readout.textContent=value+'%'
    slider.setAttribute('aria-valuetext',readout.textContent)
  }
  showLevel(c.volume)
  let editing=false
  slider.oninput=()=>{
    if(!editing){
      recordEdit()
      editing=true
      $('undo').disabled=false
      $('redo').disabled=true
    }
    const value=slider.valueAsNumber
    clips[index].volume=value
    showLevel(value)
    if(active===index)$('volume').value=value
    updateLiveLevel?.(index)
  }
  slider.onchange=slider.onblur=()=>{editing=false}
  volumeRow.append(slider,readout)
  tools.append(volumeRow)
  const menu=document.createElement('button')
  menu.textContent='⋯'
  menu.setAttribute('aria-label','Opcje klipu · '+c.name)
  tools.append(menu)
  menu.onclick=()=>{
    if(active!==index){active=index;render()}
    $('clipMenu').open=true
    $('clipMenu').querySelector('summary').focus()
  }
  dock.append(tools)
  return dock
}

function paintClip(bar,c){
  const slot=bar.parentElement
  slot.style.setProperty('--at',(100*c.at/span)+'%')
  slot.style.setProperty('--duration',(100*duration(c)/span)+'%')
  slot.querySelector('.clip-tempo').textContent=tempoLabel(c)
  const length=duration(c), scale=fadeScale(c)
  for(const marker of bar.querySelectorAll('[data-fade]')){
    const inward=marker.dataset.fade==='fadeIn'
    const fraction=c[marker.dataset.fade]*scale/length
    const boundary=inward ? fraction : 1-fraction
    marker.style.left='clamp(8px,'+(100*boundary)+'%,calc(100% - 8px))'
    const curve=c[inward ? 'attackCurve' : 'releaseCurve']
    marker.title=(inward ? 'Narastanie' : 'Wyciszanie')+' · '+(curve==='equal' ? 'Equal Power' : 'Liniowa')+' · kliknij, aby zmienić krzywą'
  }
  bar.waveClip=c
  paintVisibleWave(bar)
}
function paintVisibleWave(bar){
  const c=bar.waveClip
  const strip=drawWave(bar.querySelector('canvas'),c,document.querySelector('.timeline-scroll').getBoundingClientRect())
  if(!strip)return
  const {g,left,width,full,height}=strip, length=duration(c)
  bar.querySelector('span').style.paddingLeft=(left+18)+'px'
  function shade(start,end,color){
    g.fillStyle=color
    g.fillRect(start*full-left,0,(end-start)*full,height)
  }
  for(const tr of c.transitions ?? [])shade(tr.start/length,(tr.start+tr.length)/length,'#a480ff55')
  if(selection && active===c.index)shade((selection.begin-c.begin)/(c.end-c.begin),(selection.end-c.begin)/(c.end-c.begin),'#85dafa55')
  g.beginPath()
  for(let x=0;x<=Math.ceil(width);x+=1)g.lineTo(x,height-2-(height-4)*envelope(c,length*(x+left)/full))
  g.strokeStyle='#ffaacb'
  g.lineWidth=1.5
  g.stroke()
}
function drawTicks(timeline,ruler,timelineWidth){
  const ideal=Math.max(.001,span*77/timelineWidth)
  const magnitude=10**Math.floor(Math.log10(ideal))
  const step=magnitude*[1,2,5,10].find(n=>n*magnitude>=ideal)
  timeline.style.setProperty('--grid',(100*step/span)+'%')
  ruler.style.setProperty('--minor',(100*Math.max(.001,step/10)/span)+'%')
  const view=ruler.closest('.timeline-scroll')
  const pixels=step*timelineWidth/span
  const first=Math.max(0,Math.floor(view.scrollLeft/pixels)-1)
  const last=Math.ceil((view.scrollLeft+view.clientWidth)/pixels)+1
  ruler.replaceChildren()
  for(let i=first;i<=last && i*step<span;i++){
    const tick=document.createElement('span')
    tick.textContent=format(i*step)
    tick.style.left=(100*i*step/span)+'%'
    ruler.append(tick)
  }
}
function renderTimeline(items){
  const zoom=2**Number($('zoom').value), timeline=$('timeline')
  timeline.style.width=(100*zoom)+'%'
  const ruler=$('ruler')
  const waveHeight=52+Math.round(9*Math.log2(zoom))
  timeline.style.setProperty('--wave-height',waveHeight+'px')
  const rowHeight=waveHeight+60
  const timelineWidth=Math.max(1,timeline.clientWidth)
  const controlDuration=parseFloat(getComputedStyle(timeline).getPropertyValue('--controls-width'))*span/timelineWidth
  drawTicks(timeline,ruler,timelineWidth)
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
    bar.append(label,canvas)
    for(const edge of ['left','right','stretch']){
      const handle=document.createElement('i')
      handle.dataset.edge=edge
      handle.title=({left:'Lewa krawędź',right:'Prawa krawędź',stretch:'Przeciągnij, aby zmienić tempo'})[edge]
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
    slot.style.top=(23+row*rowHeight)+'px'
    lane.style.height=(25+ends.length*rowHeight)+'px'
    paintClip(bar,clip)
    if(selection && active===index){
      const trim=document.createElement('button')
      trim.className='trim-range'
      trim.textContent='Przytnij zaznaczenie'
      trim.onclick=()=>trimSelection(true)
      slot.querySelector('.clip-tools').after(trim)
    }
    bar.onclick=e=>{if(e.detail===0){active=index;render()}}
    bar.oncontextmenu=e=>{
      e.preventDefault()
      active=index
      render()
      $('clipMenu').open=true
      $('clipMenu').querySelector('summary').focus()
    }
    bar.onpointerdown=e=>{
      if(e.button!==0 || !e.isPrimary)return
      const edge=e.target.dataset.edge, origin=e.clientX
      const fadeKey=e.target.dataset.fade
      if(fadeKey) {
        editFadePoint(e,bar,clip,index,fadeKey)
        return
      }
      const scale=span/timeline.getBoundingClientRect().width
      const selecting=!edge && e.target.tagName!=='SPAN'
      let draft={...clip}, moved=false
      bar.setPointerCapture(e.pointerId)
      function update(event){
        const dx=event.clientX-origin
        if(!moved && Math.hypot(dx,event.clientY-e.clientY)<3)return
        if(!moved)stop()
        moved=true
        const delta=Math.round(dx*scale*1000)/1000
        const minimum=1/clip.buffer.sampleRate
        if(selecting){
          const bounds=bar.getBoundingClientRect()
          const time=x=>clip.begin+Math.max(0,Math.min(1,(x-bounds.left)/bounds.width))*(clip.end-clip.begin)
          active=index
          selection={begin:Math.min(time(origin),time(event.clientX)),end:Math.max(time(origin),time(event.clientX))}
          paintVisibleWave(bar)
          $('range').textContent=format(clip.at+(selection.begin-clip.begin)/clip.speed)+' – '+format(clip.at+(selection.end-clip.begin)/clip.speed)
          return
        }else if(edge==='stretch'){
          const desired=duration(clip)+delta
          draft.speed=Math.max(.25,Math.min(4,(clip.end-clip.begin)/Math.max(.001,desired)))
        }else if(edge==='left'){
          const shift=Math.max(-clip.at,-clip.begin/clip.speed,Math.min(delta,duration(clip)-minimum/clip.speed))
          draft.begin=clip.begin+shift*clip.speed
          draft.at=clip.at+shift
        }else if(edge==='right'){
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
        if(moved && selecting){
          render(selection?.end>selection?.begin ? selection : null)
          return
        }
        if(moved){
          remember()
          items.forEach((item,i)=>{clips[i].offset=item.at})
          Object.assign(clips[index],{begin:draft.begin,end:draft.end,offset:draft.at,speed:draft.speed,track:draft.track,fadeIn:draft.fadeIn,fadeOut:draft.fadeOut})
        }
        nextTrack=Math.max(nextTrack,draft.track+1)
        active=index
        if(!moved)seekTimeline(event.clientX)
        render()
      }
    }
  })
}
$('zoom').oninput=()=>{
  const view=document.querySelector('.timeline-scroll')
  const oldWidth=$('timeline').clientWidth
  const playhead=displayedTime*oldWidth/span-view.scrollLeft
  const anchor=playhead>=0 && playhead<=view.clientWidth ? playhead : view.clientWidth/2
  const fraction=(view.scrollLeft+anchor)/oldWidth
  const label=Number((2**Number($('zoom').value)).toFixed(1))+'×'
  $('zoomValue').textContent=label
  $('zoom').setAttribute('aria-valuetext',label)
  renderTimeline(arrangement())
  view.scrollLeft=fraction*$('timeline').clientWidth-anchor
}
function render(chosen){
  $('bpmStatus').textContent=''
  selection=chosen?.end>chosen?.begin ? chosen : null
  drag=null
  $('trim').disabled=!selection
  const items=arrangement(), total=lengthOf(items)
  span=total ? Math.max(0.01,total*1.25) : 30
  $('clipList').hidden=!clips.length
  cursor=Math.min(cursor,span)
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
    $('releaseCurve').value=current().releaseCurve ?? 'linear'
    $('attackCurve').value=current().attackCurve ?? 'linear'
    $('preserve').checked=current().preserve
    $('curve').value=current().curve
    $('crossLength').value=current().crossLength ?? ''
    $('properties').textContent=current().name
    $('filter').value=current().filter || ''
    $('solo').setAttribute('aria-pressed',Boolean(current().solo))
    $('openStems').disabled=Boolean(stemJob || current().group)
    $('stemGroup').hidden=!current().group
    if(current().group){
      const group=items.filter(c=>c.group===current().group)
      $('groupName').textContent='Grupa · '+current().groupName
      $('groupStart').value=Number(Math.min(...group.map(c=>c.at)).toFixed(6))
      $('groupFactor').value=100
      $('groupStatus').textContent=''
    }
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

const effectsLibrary=$('effectsLibrary')
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
function syncEffectsPanel(){
  if(!effectsLibrary.open){stopAudition();return}
  effectPosition=displayedTime
  cursor=effectPosition
  stop()
  $('effectTime').textContent=format(effectPosition)
  $('effectStatus').textContent=''
}
function closeEffects(){
  stopAudition()
  effectsLibrary.open=false
  $('openEffects').focus({preventScroll:true})
}
$('closeEffects').onclick=closeEffects
effectsLibrary.ontoggle=syncEffectsPanel
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && effectsLibrary.open)closeEffects()
})
document.addEventListener('pointerdown',event=>{
  if(effectsLibrary.open && !effectsLibrary.contains(event.target)){
    stopAudition()
    effectsLibrary.open=false
  }
})
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
$('effectStatus').textContent=''
if(effectsLibrary.open)syncEffectsPanel()
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
$('trim').onclick=()=>trimSelection(false)
function trimSelection(onTimeline){
  if(!selection)return
  const items=arrangement(),c=items[active]
  remember()
  if(onTimeline){
    items.forEach((item,i)=>{clips[i].offset=item.at})
    current().offset=c.at+(selection.begin-c.begin)/c.speed
  }
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
for(const key of ['preserve','curve','attackCurve','releaseCurve','crossLength']) $(key).onchange=()=>{
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
function seekTimeline(x){
  stop()
  const rect=$('timeline').getBoundingClientRect(),total=lengthOf(arrangement())
  cursor=Math.max(0,Math.min(span,(x-rect.left)*span/rect.width))
  showTime(cursor,total)
}
$('lanes').addEventListener('click',e=>{
  if(!e.target.closest('button,input,label'))seekTimeline(e.clientX)
})
let rulerPointer=null, pointerY=0
function refreshRulerHover(){
  const guide=$('hoverGuide'), label=$('hoverTime')
  guide.hidden=label.hidden=rulerPointer===null
  if(guide.hidden)return
  const box=$('ruler').getBoundingClientRect()
  const viewport=$('ruler').closest('.timeline-scroll').getBoundingClientRect()
  const x=Math.max(0,Math.min(box.width,rulerPointer-box.left))
  label.style.top=Math.max(0,Math.min($('timeline').clientHeight-label.offsetHeight,pointerY-box.top-22))+'px'
  guide.style.left=x+'px'
  label.textContent=format(span*x/box.width)
  const maxLeft=viewport.right-box.left-label.offsetWidth
  label.style.left=Math.max(viewport.left-box.left,Math.min(x+5,maxLeft))+'px'
}
function trackRuler(event){
  pointerY=event.clientY
  rulerPointer=event.clientX
  refreshRulerHover()
}
function hideGuide(){
  rulerPointer=null
  refreshRulerHover()
}
for(const type of ['pointerenter','pointermove','pointerdown']) $('timeline').addEventListener(type,trackRuler)
$('timeline').addEventListener('pointerleave',hideGuide)
$('timeline').addEventListener('pointercancel',hideGuide)
$('timeline').addEventListener('pointerup',event=>{if(event.pointerType!=='mouse')hideGuide()})
let scrollFrame
document.querySelector('.timeline-scroll').addEventListener('scroll',()=>{
  refreshRulerHover()
  cancelAnimationFrame(scrollFrame)
  scrollFrame=requestAnimationFrame(()=>{
    drawTicks($('timeline'),$('ruler'),$('timeline').clientWidth)
    document.querySelectorAll('.wave-clip').forEach(paintVisibleWave)
  })
})
$('ruler').onpointerdown=e=>{
  if(!clips.length || e.button!==0)return
  stop()
  const ruler=$('ruler'), box=ruler.getBoundingClientRect(), total=lengthOf(arrangement())
  const time=x=>Math.min(span,Math.max(0,(x-box.left)*span/box.width))
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
$('clipSplit').onclick=$('split').onclick=()=>{
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
    // The user can adjust a clip while pitch-preserving audio is being prepared.
    function syncLevel(c){
      c.volume=clips[c.index].volume
      c.muted=clips[c.index].muted || (mode==='Mix' && soloMutes(clips[c.index]))
    }
    items.forEach(syncLevel)
    let applyLevels
    updateLiveLevel=index=>{
      const clip=items.find(c=>c.index===index)
      if(clip){
        items.forEach(syncLevel)
        applyLevels()
      }
    }
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
      applyLevels=refreshLoop
      await refreshLoop()
    }else{
      const gates=new Map()
      start=context.currentTime+.04
      sources=schedule(context,items,start,from,to,(gain,c,level)=>{
        const gate=context.createGain()
        gate.gain.value=c.muted ? 0 : level
        gain.connect(gate).connect(context.destination)
        gates.set(c,gate)
      })
      applyLevels=()=>{
        const peak=mixPeak(items)
        for(const [clip,gate] of gates){
          const level=clip.muted ? 0 : clip.volume/100/peak
          gate.gain.setTargetAtTime(level,context.currentTime,.003)
        }
      }
      begin()
    }
    function tick(){
      const t=Math.max(0,context.currentTime-start)
      showTime(origin+from+(repeat?t%length:Math.min(t,length)),total)
      if(repeat || t<length)frame=requestAnimationFrame(tick)
      else {sources=[];playbackMode=null;updateLiveLevel=null;updatePause()}
    }
  }catch{
    if(token===revision){
      stop()
      $('message').textContent='Nie udało się przygotować odsłuchu.'
    }
  }
}
$('play').onclick=()=>{
  const items=mixItems(),total=lengthOf(items)
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
function soloMutes(clip){return !clip.solo && clips.some(c=>c.solo && !c.muted)}
function mixItems(){return arrangement().map(c=>({...c,muted:c.muted || soloMutes(c)}))}
function updateExports(){
  $('clipWav').disabled=$('clipMp3').disabled=exporting || !clips.length
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
async function exportMix(format,clipOnly=false){
  showFormats(false)
  exporting=true
  updateExports()
  $('message').textContent='Trwa eksport '+format.toUpperCase()+'…'
  try{
    const selected=current()
    const items=clipOnly ? [{...selected,at:0,muted:false,transitions:[]}] : mixItems()
    const rate=format==='mp3' ? 44100 : context.sampleRate, seconds=lengthOf(items)
    const offline=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate)
    await prepare(items.filter(c=>!c.muted))
    schedule(offline,items,0,0,seconds)
    const buffer=await offline.startRendering()
    const blob=format==='mp3' ? await encodeMp3(buffer) : encodeWav(buffer)
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob);a.download=(clipOnly ? selected.name : 'mixlab')+'.'+format;a.click()
    $('message').textContent='Gotowe.'
    setTimeout(()=>URL.revokeObjectURL(a.href),30000)
  }catch{$('message').textContent='Eksport nie powiódł się. Spróbuj skrócić miks.'}
  finally{exporting=false;updateExports()}
}
let stemJob=null
let inputRange=null
function showStemScope(){
  const range=$('stemScope').value==='selection' ? inputRange : current()
  const issue=range ? deviceLimit(range.end-range.begin) : 'Najpierw zaznacz fragment na fali klipu.'
  $('stemStatus').textContent=issue || 'Czas źródłowy '+format(range.begin)+' – '+format(range.end)
  $('startStems').disabled=Boolean(issue)
}
$('openStems').onclick=async()=>{
  const c=current()
  if(!c || c.group || stemJob)return
  const begin=Math.max(c.begin,selection?.begin ?? c.end),end=Math.min(c.end,selection?.end ?? c.begin)
  inputRange=end-begin>=1/c.buffer.sampleRate ? {begin,end} : null
  $('stemScope').options[1].disabled=!inputRange
  $('stemScope').value=inputRange ? 'selection' : 'clip'
  $('stemSource').textContent=c.name
  showStemScope()
  $('stemDialog').showModal()
  const cached=await modelCached()
  $('stemDownload').textContent=cached
    ? 'Model UVR-MDXNET Main · 66,8 MB w pamięci lokalnej.'
    : 'Model UVR-MDXNET Main · 66,8 MB do pobrania. Pierwsze użycie wymaga też silnika ONNX (~24 MB).'
}
$('stemScope').onchange=showStemScope
$('closeStems').onclick=()=>$('stemDialog').close()
$('cancelJob').onclick=()=>stemJob?.abort()

function insertStems(source,begin,end,result){
  const index=clips.indexOf(source), items=arrangement()
  if(index<0 || begin<source.begin || end>source.end || source.group)
    throw Error('Klip zmienił się podczas separacji. Wybierz go ponownie, aby użyć wyniku.')
  const clip=items[index], group=crypto.randomUUID()
  const partial=begin>clip.begin || end<clip.end
  const common={...source,group,groupName:source.name,muted:false}
  const additions=[]
  const at=time=>clip.at+(time-clip.begin)/clip.speed
  let track=nextTrack
  // Preserve the source envelope across a partial cut, including the slopes
  // already in progress at either boundary. Store time in source coordinates.
  const inherited=(partial || clip.transitions.length) ? {
    begin:clip.begin,end:clip.end,speed:clip.speed,fadeIn:clip.fadeIn,fadeOut:clip.fadeOut,
    attackCurve:clip.attackCurve,releaseCurve:clip.releaseCurve,transitions:clip.transitions
  } : null
  function piece(role,name,buffer,first,last,origin,lane){
    additions.push({...common,name:source.name+' · '+name,stemRole:role,track:lane,buffer,
      begin:first,end:last,offset:at(origin+first),sourceOrigin:origin,inherited,
      fadeIn:inherited ? 0 : source.fadeIn,fadeOut:inherited ? 0 : source.fadeOut})
  }
  for(const [role,name] of [['vocals','Wokal'],['accompaniment','Podkład']]){
    piece(role,name,result[role],0,end-begin,begin,track++)
  }
  if(partial){
    if(clip.begin<begin)piece('remainder','Przed zaznaczeniem',source.buffer,clip.begin,begin,0,track)
    if(end<clip.end)piece('remainder','Po zaznaczeniu',source.buffer,end,clip.end,0,track)
    track++
  }
  remember()
  items.forEach((item,i)=>{clips[i].offset=item.at})
  Object.assign(source,{group,groupName:source.name,stemRole:'original',muted:true,solo:false})
  active=clips.length
  clips.push(...additions)
  nextTrack=track
}

$('startStems').onclick=async()=>{
  if(stemJob || !current())return
  const source=current()
  const {begin,end}=$('stemScope').value==='selection' ? inputRange : source
  const job=new AbortController()
  stemJob=job
  $('stemDialog').close()
  $('openStems').disabled=true
  $('stemJob').hidden=false
  $('jobTitle').textContent=source.name
  function progress({stage,done,total}){
    const bar=$('jobProgress')
    let label=stage
    if(total){
      bar.max=total
      bar.value=done
      label+=stage==='Pobieranie wag' ? ' · '+(done/1e6).toFixed(1)+' / '+(total/1e6).toFixed(1)+' MB' : ' · '+done+' / '+total+' segmentów'
    }else bar.removeAttribute('value')
    $('jobStage').textContent=label
  }
  try{
    const result=await separateClip(source.buffer,begin,end,job.signal,progress)
    job.signal.throwIfAborted()
    insertStems(source,begin,end,result)
    $('message').textContent='Dodano wokal i podkład · '+result.backend+' · '+result.seconds.toFixed(1)+' s. '+
      (result.stored ? 'Wynik zapisany lokalnie.' : 'Wynik jest dostępny w tej sesji.')
  }catch(error){
    $('message').textContent=job.signal.aborted ? 'Anulowano separację.' : error.message
  }finally{
    stemJob=null
    $('stemJob').hidden=true
    render()
  }
}
$('applyGroup').onclick=()=>{
  const items=arrangement(),group=items.filter(c=>c.group===current().group)
  const start=$('groupStart').valueAsNumber,factor=$('groupFactor').valueAsNumber/100
  if(!Number.isFinite(start) || start<0 || !Number.isFinite(factor) ||
      group.some(c=>c.speed*factor<.25 || c.speed*factor>4)){
    $('groupStatus').textContent='Podaj start od 0 s i tempo, które utrzyma wszystkie klipy w zakresie 25–400%.'
    return
  }
  const anchor=Math.min(...group.map(c=>c.at))
  remember()
  items.forEach((item,i)=>{clips[i].offset=item.at})
  for(const c of group){
    const item=clips[c.index]
    item.offset=start+(c.at-anchor)/factor
    item.speed=c.speed*factor
    item.fadeIn/=factor
    item.fadeOut/=factor
    if(item.crossLength!=null)item.crossLength/=factor
  }
  render()
}

$('clipWav').onclick=()=>exportMix('wav',true)
$('clipMp3').onclick=()=>exportMix('mp3',true)
$('filter').onchange=()=>{remember();current().filter=$('filter').value;render()}
$('solo').onclick=()=>{
  recordEdit()
  current().solo=!current().solo
  updateLiveLevel?.(active)
  render()
}
$('save').onclick=()=>exportMix('wav')
$('mp3').onclick=()=>exportMix('mp3')
render()

const viewport=document.querySelector('.timeline-scroll')
let viewportWidth=viewport.clientWidth
new ResizeObserver(()=>{
  if(viewport.clientWidth===viewportWidth)return
  viewportWidth=viewport.clientWidth
  if(current())draw()
  renderTimeline(arrangement())
}).observe(viewport)
