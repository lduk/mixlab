// Keep peak pairs for full blocks. Boundary samples are read at native resolution.
const summaries=new WeakMap()
const block=128
function peaks(buffer){
  if(summaries.has(buffer))return summaries.get(buffer)
  const data=buffer.getChannelData(0), pairs=new Float32Array(2*Math.ceil(data.length/block))
  for(let start=0;start<data.length;start+=block){
    let low=1,high=-1
    for(let i=start;i<Math.min(data.length,start+block);i++){low=Math.min(low,data[i]);high=Math.max(high,data[i])}
    const j=2*(start/block)
    pairs[j]=low
    pairs[j+1]=high
  }
  summaries.set(buffer,pairs)
  return pairs
}
export function drawWave(canvas,clip,view){
  const rect=canvas.parentElement.getBoundingClientRect()
  const left=Math.max(0,view.left-rect.left-1)
  const width=Math.min(rect.width-2-left,view.right-rect.left-left)
  canvas.hidden=width<=0
  if(width<=0)return
  const full=Math.max(1,rect.width-2), height=canvas.clientHeight
  const dpr=window.devicePixelRatio || 1
  canvas.style.left=left+'px'
  canvas.style.width=width+'px'
  canvas.width=Math.max(1,Math.ceil(width*dpr))
  canvas.height=Math.max(1,Math.round(height*dpr))
  const g=canvas.getContext('2d'),data=clip.buffer.getChannelData(0)
  const step=(clip.end-clip.begin)*clip.buffer.sampleRate/full
  const start=clip.begin*clip.buffer.sampleRate+left*step
  const samples=width*step/canvas.width, mid=canvas.height/2
  const pairs=samples>=block ? peaks(clip.buffer) : null
  g.fillStyle='#dbf3ff'
  for(let x=0;x<canvas.width;x++){
    let i=Math.min(data.length-1,Math.floor(start+x*samples))
    const end=Math.min(data.length,Math.max(i+1,Math.floor(start+(x+1)*samples)))
    let low=0,high=0
    while(i<end){
      if(pairs && i%block===0 && i+block<=end){
        low=Math.min(low,pairs[2*i/block]);high=Math.max(high,pairs[2*i/block+1]);i+=block
      }else{
        low=Math.min(low,data[i]);high=Math.max(high,data[i]);i++
      }
    }
    g.fillRect(x,mid-high*mid,1,Math.max(1,(high-low)*mid))
  }
  g.setTransform(canvas.width/width,0,0,canvas.height/height,0,0)
  return {g,left,width,full,height}
}
