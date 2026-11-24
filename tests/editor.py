"""Browser acceptance checks. Start site/ on port 8213 before running."""
import array
import math
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright

def tone(path, hz):
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, 22050, 0, 'NONE', ''))
        data = array.array('h', (int(12000*math.sin(2*math.pi*hz*i/22050)) for i in range(220500)))
        output.writeframes(data.tobytes())

with tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
    root = Path(directory)
    for hz in [440, 660]:
        tone(root/f'{hz}.wav', hz)
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 920, 'height': 720}, has_touch=True)
    page.set_default_timeout(5000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:8213')
    def field(id, value):
        item = page.locator('#'+id)
        item.fill(str(value))
        item.press('Tab')
    def export():
        page.locator('#exportMenu').click()
        with page.expect_download() as download:
            page.locator('#save').click()
        with wave.open(str(download.value.path())) as audio:
            rate=audio.getframerate()
            signal=array.array('h', audio.readframes(audio.getnframes()))[::2]
        return rate,signal
    page.locator('#files').set_input_files(root/'440.wav')
    page.locator('[data-action=faster]').first.click()
    assert page.locator('.clip-tempo').first.inner_text()=='101%'
    page.locator('[data-action=slower]').first.click()
    assert page.locator('.clip-tempo').first.inner_text()=='100%'
    for percent in (125,75):
        field('speed',percent)
        rate,signal=export()
        assert abs(len(signal)/rate-1000/percent)<.001
        middle=signal[rate:rate*2]
        hz=sum(a<0<=b for a,b in zip(middle,middle[1:]))
        assert abs(hz-440)<=2,(percent,hz)
    page.locator('#undo').click()
    assert page.locator('#speed').input_value()=='125'
    field('speed',100)
    def gesture(locator, dx,dy=0):
        locator.scroll_into_view_if_needed()
        box=locator.bounding_box()
        x=box['x']+box['width']/2
        y=box['y']+box['height']*.65
        page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=8);page.mouse.up()
    field('sourceBpm',100)
    toolbar=page.locator('.clip-tools').first
    assert toolbar.inner_text().startswith('100 BPM')
    toolbar.locator('[data-action=faster]').click()
    assert page.locator('#targetBpm').input_value()=='101'
    toolbar.locator('[data-action=slower]').click()
    assert page.locator('#targetBpm').input_value()=='100'
    ruler=page.locator('#ruler')
    ruler.scroll_into_view_if_needed()
    box=ruler.bounding_box()
    x=round(box['x']+box['width']*.35)
    clock=page.locator('#clock').inner_text()
    page.mouse.move(x,box['y']+15)
    value=page.locator('#hoverTime').inner_text()
    assert abs(float(value.split(':')[1])-(x-box['x'])*12.5/box['width'])<.002
    assert page.locator('#hoverGuide').is_visible() and page.locator('#clock').inner_text()==clock
    page.mouse.move(x,box['y']+box['height']+4)
    assert page.locator('#hoverGuide').is_hidden()
    page.locator('#zoom').select_option('4')
    page.locator('.timeline-scroll').evaluate('node=>node.scrollLeft=400')
    visible=page.locator('.timeline-scroll').bounding_box()
    scaled=ruler.bounding_box()
    x=round(visible['x']+.55*visible['width'])
    page.mouse.move(x,scaled['y']+10)
    hovered=page.locator('#hoverTime').inner_text()
    assert abs(float(hovered.split(':')[1])-(x-scaled['x'])*12.5/scaled['width'])<.002
    page.locator('#zoom').select_option('1')
    page.locator('#play').click()
    page.wait_for_function("!document.getElementById('pauseMix').disabled")
    toolbar.locator('[data-action=mute]').click()
    assert page.locator('#pauseMix').is_enabled()
    page.locator('#stop').click()
    rate,silence=export()
    assert max(map(abs,silence))==0 and len(silence)==10*rate
    toolbar.locator('[data-action=mute]').click()
    assert page.locator('#volume').input_value()=='100'
    field('targetBpm',125)
    assert page.locator('#speed').input_value()=='125'
    rate,signal=export()
    assert abs(len(signal)/rate-8)<.001
    page.locator('#undo').click()
    assert page.locator('#targetBpm').input_value()=='100'
    bar=page.locator('#lanes .wave-clip').first
    page.locator('button[data-mode=attack]').click()
    bar.click(position={'x':round(bar.bounding_box()['width']*.4),'y':38})
    assert abs(float(page.locator('#fadeIn').input_value())-4)<.05
    for curve,expected in [('linear',.5),('equal',2**-.5)]:
        page.locator('#attackCurve').select_option(curve)
        rate,signal=export()
        assert abs(max(signal[2*rate:2*rate+rate//50])/max(signal)-expected)<.03
    page.locator('button[data-mode=move]').click()
    gesture(bar.locator('.fade-end'),-bar.bounding_box()['width']*.2)
    assert abs(float(page.locator('#fadeIn').input_value())-2)<.05
    field('fadeIn',0)
    # Place a fade at six seconds on a ten-second clip and adjust its visible marker.
    page.locator('button[data-mode=fade]').click()
    bar=page.locator('#lanes .wave-clip').first
    bar.click(position={'x':round(bar.bounding_box()['width']*.6),'y':38})
    assert abs(float(page.locator('#fadeOut').input_value())-4)<.05
    rate,signal=export()
    def peak(seconds):
        start=int(seconds*rate)
        return max(signal[start:start+rate//50])
    assert .96<peak(5.9)/peak(1)<1.04
    assert .46<peak(8)/peak(1)<.54
    assert peak(9.95)<peak(1)*.03
    page.locator('button[data-mode=move]').click()
    gesture(bar.locator('.fade-start'),-bar.bounding_box()['width']*.2)
    assert abs(float(page.locator('#fadeOut').input_value())-6)<.05
    assert page.locator('#offset').input_value()==''
    page.locator('#undo').click()
    assert abs(float(page.locator('#fadeOut').input_value())-4)<.05
    page.locator('#undo').click()
    assert page.locator('#fadeOut').input_value()=='0'
    edge=page.locator('[data-edge=right]').first
    gesture(edge,-70)
    assert float(page.locator('#end').input_value())<10
    gesture(edge,150)
    assert float(page.locator('#end').input_value())==10
    page.locator('#undo').click()
    assert float(page.locator('#end').input_value())<10
    page.locator('#redo').click()
    page.locator('#files').set_input_files(root/'660.wav')
    page.wait_for_selector('[data-track="2"] canvas')
    assert page.locator('#sourceBpm').input_value()==''
    assert page.locator('#targetBpm').is_disabled()
    field('offset',5)
    rate,signal=export()
    assert abs(len(signal)/rate-15)<.001
    secondMute=page.locator('[data-action=mute]').nth(1)
    secondMute.click()
    singleRate,single=export()
    assert singleRate==rate and len(single)==len(signal)
    assert single[rate:rate*2]==signal[rate:rate*2]
    assert max(map(abs,single[rate*11:]))==0
    secondMute.click()
    second=page.locator('[data-track="2"] canvas')
    shift=page.locator('[data-track="1"]').bounding_box()['y']-page.locator('[data-track="2"]').bounding_box()['y']
    gesture(second,0,shift)
    assert page.locator('[data-track="1"] canvas').count()==2
    field('crossLength',3)
    page.locator('#curve').select_option('linear')
    page.locator('#undo').click()
    assert page.locator('#curve').input_value()=='equal'
    page.locator('#redo').click()
    rate,cross=export()
    assert len(cross)==len(signal) and cross!=signal
    page.locator('#auto').uncheck()
    rate,plain=export()
    assert plain==signal
    page.locator('#undo').click()
    assert page.locator('#auto').is_checked()
    page.locator('button[data-mode=stretch]').click()
    gesture(page.locator('[data-track="1"] [data-edge=right]').last,-30)
    assert float(page.locator('#speed').input_value())>100
    ruler=page.locator('#ruler')
    gesture(ruler,60)
    assert page.locator('#loop').is_checked()
    page.locator('#play').click()
    page.wait_for_function("!document.getElementById('pauseMix').disabled")
    secondMute.click()
    page.wait_for_timeout(100)
    assert page.locator('#pauseMix').is_enabled()
    secondMute.click()
    page.locator('#pauseMix').click()
    assert page.locator('#pauseMix').inner_text()=='Wznów'
    page.locator('#stop').click()
    page.locator('#split').click()
    assert page.locator('#lanes canvas').count()==3
    page.locator('#exportMenu').click()
    with page.expect_download() as download:
        page.locator('#mp3').click()
    assert download.value.suggested_filename.endswith('.mp3')
    page.set_viewport_size({'width':740,'height':360})
    page.locator('#lanes .wave-clip').first.tap()
    assert page.locator('#properties').inner_text()=='440.wav'
    page.locator('button[data-mode=trim]').click()
    handle=page.locator('[data-edge=right]').first
    handle.scroll_into_view_if_needed()
    box=handle.bounding_box()
    x=box['x']+box['width']/2
    y=box['y']+box['height']*.7
    touch=page.context.new_cdp_session(page)
    before=float(page.locator('#end').input_value())
    for event,points in [('touchStart',[{'x':x,'y':y}]),('touchMove',[{'x':x-25,'y':y}]),('touchEnd',[])]:
        touch.send('Input.dispatchTouchEvent',{'type':event,'touchPoints':points})
    assert float(page.locator('#end').input_value())<before
    # Files providers may report MP3s as generic documents. Open the picker
    # through the touch control and import the MP3 exported by this session.
    phone=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    phone.goto('http://localhost:8213')
    assert phone.locator('#files').get_attribute('accept') is None
    with phone.expect_file_chooser() as picker:
        phone.locator('label.import').tap()
    picker.value.set_files({'name':'nagranie.mp3','mimeType':'application/octet-stream',
                            'buffer':Path(download.value.path()).read_bytes()})
    phone.wait_for_selector('#lanes canvas')
    assert phone.locator('#properties').inner_text()=='nagranie.mp3'
    # Distinct pulses at a half-second interval give a known 120 BPM source.
    with wave.open(str(root/'beat.wav'),'wb') as out:
        out.setparams((1,2,22050,0,'NONE',''))
        samples=array.array('h',(int(15000*math.sin(i*.1)) if i%11025<650 else 0 for i in range(220500)))
        out.writeframes(samples.tobytes())
    phone.locator('#files').set_input_files(root/'beat.wav')
    phone.wait_for_function("document.getElementById('properties').textContent==='beat.wav'")
    assert phone.locator('.clip-tempo').last.inner_text()=='120 BPM'
    phone.locator('[data-action=faster]').last.tap()
    assert phone.locator('.clip-tempo').last.inner_text()=='121 BPM'
    phone.locator('#estimateBpm').tap()
    assert phone.locator('#sourceBpm').input_value()=='120'
    assert not errors,errors
    print('Acceptance checks passed')
