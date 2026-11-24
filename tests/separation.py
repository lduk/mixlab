"""Benchmark real MDX inference with local MUSDB18 7 s STEMS, without uploading recordings."""
import argparse
import json
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path

import numpy as np
import psutil
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--url', default='http://localhost:8213')
parser.add_argument('--executable', help='Optional browser executable path')
parser.add_argument('--repeat-first', type=int, metavar='N', help='Repeat the first excerpt N times for a longer multi-segment memory test')
parser.add_argument('--gpu', action='store_true')
parser.add_argument('--browser', choices=['chromium', 'firefox'], default='chromium')
args = parser.parse_args()
tracks = ['Cristina Vane - So Easy', 'Louis Cressy Band - Good Time', 'Secretariat - Borderline']

if args.repeat_first is not None:
    if args.repeat_first<1: parser.error('N must be positive')
    tracks=tracks[:1]

def decode(path, stream):
    raw = subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-map',f'0:a:{stream}',
                                   '-ar','44100','-ac','2','-f','f32le','-'])
    return np.frombuffer(raw, dtype='<f4').reshape(-1,2).T

def browser_rss():
    return sum(p.memory_info().rss for p in psutil.Process().children(recursive=True)
               if p.is_running() and p.name().lower().removesuffix('.exe') in ('chrome','chromium','firefox','firefox-bin','headless_shell','chrome-headless-shell')) / 2**20

with tempfile.TemporaryDirectory() as folder, zipfile.ZipFile(args.archive) as archive, sync_playwright() as pw:
    options = {'executable_path':args.executable} if args.executable else {}
    browser = getattr(pw,args.browser).launch(**options)
    print(args.browser,browser.version,flush=True)
    page = browser.new_page()
    page.set_default_timeout(240000)
    page.goto(args.url)
    page.on('console', lambda msg: print(msg.text[:250],flush=True) if msg.type=='error' else None)
    for name in tracks:
        path = archive.extract('test/'+name+'.stem.mp4', folder)
        parts = [decode(path,i) for i in range(1,5)]
        size = min(a.shape[1] for a in parts)
        backing = sum(a[:,:size] for a in parts[:3])
        voice = parts[3][:,:size]
        if args.repeat_first:
            voice=np.tile(voice,(1,args.repeat_first))
            backing=np.tile(backing,(1,args.repeat_first))
        fixture = np.concatenate([voice+backing,voice,backing]).astype('<f4').tobytes()
        page.route('**/__benchmark.pcm',lambda r:r.fulfill(body=fixture,content_type='application/octet-stream'))
        baseline = browser_rss()
        samples = []
        done = threading.Event()
        def monitor():
            while not done.wait(.1):
                try:
                    samples.append(browser_rss())
                except psutil.NoSuchProcess:
                    pass
        thread=threading.Thread(target=monitor,daemon=True)
        thread.start()
        try:
            result=page.evaluate("""async forceWasm=>{
              const pcm=new Float32Array(await (await fetch('__benchmark.pcm')).arrayBuffer())
              const n=pcm.length/6
              const mix=[pcm.slice(0,n),pcm.slice(n,2*n)]
              const worker=new Worker('stems-worker.js',{type:'module'})
              try{
                const output=await new Promise((resolve,reject)=>{
                  worker.onerror=e=>reject(Error(e.message))
                  worker.onmessage=({data})=>{
                    if(data.type==='result')resolve(data)
                    if(data.type==='error')reject(Error(data.message))
                  }
                  worker.postMessage({channels:mix,forceWasm})
                })
                function sdr(est,ref){
                  let target=0,noise=0
                  for(let i=0;i<ref.length;i++){target+=ref[i]**2;noise+=(est[i]-ref[i])**2}
                  return 10*Math.log10(target/noise)
                }
                const mixture=pcm.subarray(0,2*n)
                let error=0
                for(let i=0;i<2*n;i++)error=Math.max(error,Math.abs(output.vocals[i]+output.accompaniment[i]-mixture[i]))
                const metrics={backend:output.backend,seconds:output.seconds,audioSeconds:n/44100,reconstructionError:error}
                for(const [j,key] of ['vocals','accompaniment'].entries()){
                  const ref=pcm.subarray((j+1)*2*n,(j+2)*2*n)
                  const full=sdr(output[key],ref)
                  // The first blend is centred at 228352 samples. Test both
                  // stereo channels across the entire moving gain ramp.
                  function aroundJoin(pcm) {
                    const hop=228352,radius=8192
                    const slice=new Float32Array(4*radius)
                    for(let ch=0;ch<2;ch++)slice.set(pcm.subarray(ch*n+hop-radius,ch*n+hop+radius),ch*2*radius)
                    return slice
                  }
                  metrics[key]={SDR:full,improvement:full-sdr(mixture,ref),
                    joinSDR:sdr(aroundJoin(output[key]),aroundJoin(ref))}
                }
                return metrics
              }finally{worker.terminate()}
            }""",not args.gpu)
        finally:
            done.set()
            thread.join()
        result.update(track=name,repetitions=args.repeat_first or 1,baselineMiB=round(baseline),peakMiB=round(max(samples or [baseline])))
        print(json.dumps(result),flush=True)
        assert result['backend']!='pamięć lokalna' and result['reconstructionError']<1e-5
        assert all(result[key]['improvement']>0 for key in ('vocals','accompaniment'))
        page.unroute('**/__benchmark.pcm')
    browser.close()
