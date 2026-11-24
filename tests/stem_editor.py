"""Real inference + editing checks. Usage: python tests/stem_editor.py --help"""
import argparse
import array
import io
import math
import struct
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--serve', action='store_true', help='Serve site/ for the lifetime of the test process')
parser.add_argument('--url', default='http://localhost:8213/')
parser.add_argument('--browser', choices=['chromium', 'firefox'], default='chromium')
parser.add_argument('--executable')
parser.add_argument('--cdp', help='Chrome DevTools address, e.g. an adb-forwarded Android device')
args = parser.parse_args()

if args.serve:
    class Handler(SimpleHTTPRequestHandler):
        extensions_map={**SimpleHTTPRequestHandler.extensions_map,
                        '.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'}
        def log_message(self, *args):
            pass
    site=Path(__file__).resolve().parents[1]/'site'
    server=ThreadingHTTPServer(('127.0.0.1',urlsplit(args.url).port or 80),partial(Handler,directory=site))
    Thread(target=server.serve_forever,daemon=True).start()

def fixture():
    data=io.BytesIO()
    with wave.open(data,'wb') as w:
        w.setparams((1,2,22050,0,'NONE',''))
        w.writeframes(b''.join(struct.pack('<h',int(12000*math.sin(i*.035)+6000*math.sin(i*.08))) for i in range(66150)))
    return {'name':'próba.wav','mimeType':'audio/wav','buffer':data.getvalue()}

with sync_playwright() as pw:
    browser = (pw.chromium.connect_over_cdp(args.cdp) if args.cdp else
               getattr(pw,args.browser).launch(executable_path=args.executable))
    context=browser.contexts[0] if args.cdp else browser.new_context(viewport={'width':900,'height':840})
    page=context.new_page()
    page.set_default_timeout(20000)
    errors=[]
    requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:requests.append((r.method,r.url)))
    page.goto(args.url)
    print('Browser',browser.version,page.evaluate('navigator.userAgent'),flush=True)
    def import_audio():
        page.locator('#files').set_input_files(fixture())
        expect(page.locator('#properties')).to_have_text('próba.wav')
        page.locator('#clipMenu summary').click()
    def select_part():
        canvas=page.locator('#editor canvas')
        canvas.scroll_into_view_if_needed()
        box=canvas.bounding_box()
        y=box['y']+18
        page.mouse.move(box['x']+box['width']*.25,y)
        page.mouse.down()
        page.mouse.move(box['x']+box['width']*.75,y,steps=5)
        page.mouse.up()
    def start():
        select_part()
        page.locator('#openStems').click()
        expect(page.locator('#stemScope')).to_have_value('selection')
        expect(page.locator('#startStems')).to_be_enabled()
        page.locator('#startStems').click()
    def export_mix():
        page.locator('#exportMenu').click()
        with page.expect_download() as download:
            page.locator('#save').click()
        with wave.open(str(download.value.path())) as wav:
            return array.array('h',wav.readframes(wav.getnframes()))
    import_audio()
    dry=export_mix() if not args.cdp else None
    assert not any('/ai-assets/' in url for _,url in requests)
    start()
    page.wait_for_function("document.querySelector('#stemJob').hidden || document.querySelector('#jobStage').textContent.includes('Separacja ·')",timeout=240000)
    assert page.locator('#stemJob').is_visible(),page.locator('#message').inner_text()
    page.locator('#cancelJob').click()
    expect(page.locator('#message')).to_have_text('Anulowano separację.')
    expect(page.locator('.wave-clip')).to_have_count(1)
    assert not page.locator('.clip-slot.muted').count()
    start()
    page.wait_for_function("document.querySelector('#stemJob').hidden",timeout=600000)
    message=page.locator('#message').inner_text()
    print(message,flush=True)
    assert 'Dodano wokal' in message,message
    expect(page.locator('.wave-clip')).to_have_count(5)
    expect(page.locator('.clip-slot.muted')).to_have_count(1)
    expect(page.locator('#properties')).to_contain_text('Wokal')
    def select(name):
        page.locator('.wave-clip').filter(has_text=name).focus()
        page.keyboard.press('Enter')
    def number(id):return float(page.locator('#'+id).input_value())
    if dry is not None:
        combined=export_mix()
        assert abs(len(dry)-len(combined))<=2
        energy=sum(x*x for x in dry)
        error=sum((x-y)**2 for x,y in zip(dry,combined))
        assert error/energy<.002, 'Reconstructed project changed level or timing'
    start_at=number('offset')
    assert .70<start_at<.80
    page.locator('#groupStart').fill('2')
    page.locator('#groupFactor').fill('125')
    page.locator('#applyGroup').click()
    for name in ('Wokal','Podkład'):
        select(name)
        assert number('speed')==125 and abs(number('offset')-2-start_at/1.25)<.00001
    page.locator('#solo').click()
    expect(page.locator('#solo')).to_have_attribute('aria-pressed','true')
    page.locator('#filter').select_option('lowpass')
    if not args.cdp:
        for selector in ['#clipWav','#clipMp3']:
            with page.expect_download() as download:
                page.locator(selector).click()
            assert 'Podkład' in download.value.suggested_filename and not download.value.failure()
    # Changing one stem's tempo leaves its sibling independent.
    page.locator('#speed').fill('110')
    page.locator('#speed').press('Tab')
    select('Wokal')
    assert number('speed')==125
    # A fresh session importing the identical section must hit persistent storage.
    page.reload()
    import_audio()
    before=len(requests)
    start()
    expect(page.locator('#message')).to_contain_text('pamięć lokalna',timeout=30000)
    assert not any('/ai-assets/' in url for _,url in requests[before:])
    page.locator('#undo').click()
    expect(page.locator('.wave-clip')).to_have_count(1)
    expect(page.locator('.clip-slot.muted')).to_have_count(0)
    page.locator('#redo').click()
    expect(page.locator('.wave-clip')).to_have_count(5)
    assert not errors,errors
    assert all(method=='GET' for method,url in requests),requests
    print('Stem editor checks passed',flush=True)
    browser.close()
