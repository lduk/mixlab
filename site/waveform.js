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
  const step=(clip.end-clip.begin)*clip.buffer.sampleRate/full
  const start=clip.begin*clip.buffer.sampleRate+left*step
  const g=canvas.getContext('2d')
  paintSamples(g,clip.buffer,start,width*step/canvas.width,clip.begin*clip.buffer.sampleRate,clip.end*clip.buffer.sampleRate)
  g.setTransform(canvas.width/width,0,0,canvas.height/height,0,0)
  return {g,left,width,full,height}
}

export function paintSamples(g,buffer,start,samples,begin=0,endFrame=buffer.length){
  const {width,height}=g.canvas, mid=height/2
  const data=buffer.getChannelData(0)
  const first=Math.max(0,Math.floor(begin))
  const last=Math.min(data.length-1,Math.max(first,Math.ceil(endFrame)-1))
  if(samples<=4){
    // Include the neighbouring frames so the trace continues across the viewport edge.
    const from=Math.max(first,Math.floor(start))
    const to=Math.min(last,Math.ceil(start+width*samples))
    g.strokeStyle=g.fillStyle='#dbf3ff'
    g.lineWidth=Math.max(1,devicePixelRatio*.9)
    g.lineJoin='round'
    g.beginPath()
    for(let i=from;i<=to;i++)g.lineTo((i-start)/samples,mid-data[i]*(mid-1))
    g.stroke()
    if(from===to || samples*devicePixelRatio<=.16){
      const size=Math.max(2,devicePixelRatio*2)
      for(let i=from;i<=to;i++){
        g.fillRect(Math.round((i-start)/samples-size/2),Math.round(mid-data[i]*(mid-1)-size/2),size,size)
      }
    }
    return
  }
  const pairs=samples>=block ? peaks(buffer) : null
  g.fillStyle='#dbf3ff'
  for(let x=0;x<width;x++){
    let i=Math.min(last,Math.floor(start+x*samples))
    const end=Math.min(last+1,Math.max(i+1,Math.floor(start+(x+1)*samples)))
    let low=data[Math.max(first,i-1)],high=low
    while(i<end){
      if(pairs && i%block===0 && i+block<=end){
        low=Math.min(low,pairs[2*i/block]);high=Math.max(high,pairs[2*i/block+1]);i+=block
      }else{
        low=Math.min(low,data[i]);high=Math.max(high,data[i]);i++
      }
    }
    const top=Math.floor(mid-high*(mid-1))
    g.fillRect(x,top,1,Math.max(1,Math.ceil(mid-low*(mid-1))-top))
  }
}
