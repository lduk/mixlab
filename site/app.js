const $ = id => document.getElementById(id)
let clips = [], history = [], active = 0, context, sources = []
const current = () => clips[active]
function stop() {
  sources.forEach(s => s.stop())
  sources = []
}
function remember() {
  stop()
  history.push({clips: clips.map(c => ({...c})), active})
  if (history.length > 30) history.shift()
}
function draw() {
  const canvas = document.querySelector('canvas'), g = canvas.getContext('2d')
  const c = current(), data = c.buffer.getChannelData(0)
  g.clearRect(0,0,1000,120)
  g.fillStyle = '#394b32'
  g.fillRect(1000*c.begin/c.buffer.duration,0,1000*(c.end-c.begin)/c.buffer.duration,120)
  g.fillStyle = '#c5f16a'
  for(let x=0;x<1000;x++){
    const start=Math.floor(x*data.length/1000), width=Math.ceil(data.length/1000)
    let peak=0
    for(let j=start;j<Math.min(data.length,start+width);j+=Math.max(1,Math.floor(width/64))) peak=Math.max(peak,Math.abs(data[j]))
    g.fillRect(x,60-peak*57,1,Math.max(1,peak*114))
  }
}
function render(){
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
$('undo').onclick=()=>{stop();({clips,active}=history.pop());render()}
function schedule(ctx,items,start){
  const nodes=[]
  for(const c of items){
    const s=ctx.createBufferSource(), gain=ctx.createGain()
    s.buffer=c.buffer;s.playbackRate.value=c.speed;gain.gain.value=c.volume/100
    s.connect(gain).connect(ctx.destination)
    s.start(start,c.begin,c.end-c.begin)
    start+=(c.end-c.begin)/c.speed
    nodes.push(s)
  }
  return nodes
}
async function play(items){await context.resume();stop();sources=schedule(context,items,context.currentTime+.04)}
$('play').onclick=()=>play(clips)
$('preview').onclick=()=>play([current()])
$('stop').onclick=stop
$('save').onclick=async()=>{
  try{
    const rate=context.sampleRate, seconds=clips.reduce((n,c)=>n+(c.end-c.begin)/c.speed,0)
    const offline=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate)
    schedule(offline,clips,0)
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
