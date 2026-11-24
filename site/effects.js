// Original, locally synthesized one-shots. A fixed noise seed keeps an
// audition identical to the clip subsequently inserted in the mix.
const rate = 24000
const tau = 2*Math.PI
const sine = cycles => Math.sin(tau*cycles)

function burst(age, decay) {
  return age < 0 ? 0 : Math.exp(-age/decay)
}

function explosion(t, noise) {
  const impact = sine(38*t + 6*(1-Math.exp(-16*t))) * burst(t,0.42)
  const rumble = noise.low * (2.6 + sine(8*t)) * burst(t,0.58)
  return impact + rumble + noise.white*0.8*burst(t,0.09)
}

function siren(t) {
  // Integral of a smooth pitch sweep between 550 and 1050 Hz.
  const phase = 800*t - 250*Math.sin(tau*0.8*t)/(tau*0.8)
  return (sine(phase) + 0.19*sine(3*phase) + 0.06*sine(5*phase)) *
    Math.min(1,t/0.08,(2.5-t)/0.18)
}

function scream(t, noise, state) {
  const openness = Math.sin(Math.PI*t/1.15)
  const pitch = 390 + 310*openness + 36*sine(6.6*t) + 8*noise.low
  state.phase += pitch/rate
  // Weight the voice harmonics around the vowel resonances of an open mouth.
  let voice = 0
  for (let h=1; h<=9; h++) {
    const hz = pitch*h
    const first = Math.exp(-(((hz-920)/380)**2))
    const second = Math.exp(-(((hz-1580)/410)**2))
    const third = Math.exp(-(((hz-2950)/650)**2))
    voice += sine(h*state.phase)*(first+0.8*second+0.42*third)/Math.sqrt(h)
  }
  const rasp = (0.9 + 0.1*sine(state.phase/2)) * voice + 0.12*noise.white
  return rasp * openness**0.6
}

function whoosh(t, noise, state) {
  const swell = Math.sin(Math.PI*t/0.95)**2
  // Open and close a low-pass filter as the gust passes.
  state.wind += (0.025+0.45*swell)*(noise.white-state.wind)
  return state.wind*swell
}

function knock(t) {
  const age = t < 0.23 ? t : t < 0.48 ? t-0.23 : t-0.48
  return (sine(185*age) + 0.55*sine(313*age) + 0.2*sine(721*age)) *
    burst(age,0.036) * Math.min(1,age/0.001)
}

function bell(t) {
  return sine(659.25*t)*burst(t,0.65) + 0.48*sine(1324*t)*burst(t,0.41) +
    0.3*sine(1805*t)*burst(t,0.23) + 0.15*sine(2688*t)*burst(t,0.11)
}

function laser(t) {
  const phase = 130*t + 280*(1-Math.exp(-8*t))
  return (sine(phase)+0.24*sine(2*phase))*burst(t,0.16)
}

function applause(t, noise, state) {
  if (state.nextClap<=t) {
    state.clap=0.35+0.65*Math.abs(noise.white)
    state.nextClap=t+0.023+0.067*Math.abs(noise.low)
  }
  state.clap*=0.996
  return (noise.white-noise.low)*state.clap*Math.min(1,t/0.25,(2.1-t)/0.48)
}

export const effects = [
  {name:'Wybuch', seconds:2.4, sample:explosion},
  {name:'Syrena', seconds:2.5, sample:siren},
  {name:'Krzyk', seconds:1.15, sample:scream},
  {name:'Świst', seconds:0.95, sample:whoosh},
  {name:'Oklaski', seconds:2.1, sample:applause},
  {name:'Pukanie', seconds:0.75, sample:knock},
  {name:'Dzwonek', seconds:2.2, sample:bell},
  {name:'Laser', seconds:0.65, sample:laser}
]

const buffers = new Map()
export function effectBuffer(context, effect) {
  if (buffers.has(effect)) return buffers.get(effect)
  const buffer = context.createBuffer(1,Math.round(effect.seconds*rate),rate)
  const data = buffer.getChannelData(0)
  const noise = {white:0, low:0}
  const state = {phase:0, wind:0, nextClap:0, clap:0}
  let seed = 73411, peak = 0, energy = 0
  for (let i=0; i<data.length; i++) {
    seed = (Math.imul(1664525,seed)+1013904223) >>> 0
    noise.white = seed/2147483648-1
    noise.low += 0.065*(noise.white-noise.low)
    const edge = Math.min(1,i/(rate*0.002),(data.length-1-i)/(rate*0.018))
    data[i] = effect.sample(i/rate,noise,state)*edge
    energy += data[i]**2
    peak = Math.max(peak,Math.abs(data[i]))
  }
  const gain = Math.min(0.68/peak,0.16/Math.sqrt(energy/data.length))
  for (let i=0; i<data.length; i++) data[i] *= gain
  buffers.set(effect,buffer)
  return buffer
}
