/* ================= 背景音乐：Web Audio 现场合成的温馨小提琴曲 =================
   不依赖任何音频文件、没有版权问题。
   音色：3 个略微失谐的锯齿波（弓弦的泛音）+ 慢起弓的包络 + 5.4Hz 颤音（起弓后渐入）
        + 琴身共振（1.1kHz 附近提一点）+ 低通随起弓慢慢打开 + 大厅混响
   曲子：A 小调 8 小节一句（Am–F–C–G），64 BPM，旋律是能哼出来的那种，留了气口
   想换感觉改下面的 BPM / CHORDS / MELODY / 各段参数即可。 */
window.MUSIC = (function () {
  const BPM = 58;
  const BEAT = 60 / BPM;                 // 一拍 ≈ 0.94 秒
  const LOOP_BEATS = 32;                 // 8 小节 × 4 拍

  /* 和声：Am – F – C – G（每小节一个，8 小节一循环） */
  const CHORDS = [
    { pad: [57, 60, 64], bass: 45 },     // Am
    { pad: [53, 57, 60], bass: 41 },     // F
    { pad: [48, 55, 64], bass: 36 },     // C
    { pad: [55, 59, 62], bass: 43 }      // G
  ];

  /* 主旋律：[起始拍, MIDI 音高, 时值(拍)] —— 一句 8 小节，句尾留气口 */
  const MELODY = [
    [0, 64, 2.0], [2, 69, 2.0],          // Am : E4  A4
    [4, 67, 2.0], [6, 65, 2.0],          // F  : G4  F4
    [8, 64, 3.2],                        // C  : E4（长音，留半拍气口）
    [12, 62, 2.0], [14, 64, 2.0],        // G  : D4  E4
    [16, 72, 2.0], [18, 71, 2.0],        // Am : C5  B4
    [20, 69, 3.2],                       // F  : A4
    [24, 67, 2.0], [26, 64, 2.0],        // C  : G4  E4
    [28, 62, 3.6]                        // G  : D4（收在悬着的感觉上，好接回 Am）
  ];

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const rnd = (a, b) => a + Math.random() * (b - a);

  let ctx = null, master = null, dry = null, wetIn = null, comp = null;
  let lfo = null, lfoOut = null;                  // 全局颤音源（一个就够，接到每个音的 detune）
  let analyser = null, specBuf = null, timeBuf = null;            // 频谱探针（自检用：确认真的出声、音色是否在中频）
  let timer = null, beatIdx = 0, nextBeat = 0, playing = false;
  let volume = 0.35, scheduled = 0;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    master = ctx.createGain();
    master.gain.value = 0;                        // 由 start() 淡入
    comp = ctx.createDynamicsCompressor();        // 轻压一下，弦乐齐奏不爆音
    comp.threshold.value = -16; comp.ratio.value = 3;

    const soft = ctx.createBiquadFilter();        // 整体低通：抬高一点，让泛音透出来
    soft.type = 'lowpass';
    soft.frequency.value = 3800;
    soft.Q.value = 0.2;

    const warm = ctx.createBiquadFilter();         // 低频架：木头箱体的厚度（温馨来源）
    warm.type = 'lowshelf';
    warm.frequency.value = 300;
    warm.gain.value = 3.2;

    const air = ctx.createBiquadFilter();          // 高频只留一点点晶莹，不要刺
    air.type = 'highshelf';
    air.frequency.value = 6500;
    air.gain.value = 1.0;

    // 大厅混响：一段衰减噪声当脉冲响应
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 3.4);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    }
    conv.buffer = buf;
    wetIn = ctx.createGain(); wetIn.gain.value = 0.55;    // 混响发送量
    const wetOut = ctx.createGain(); wetOut.gain.value = 0.56;

    dry = ctx.createGain(); dry.gain.value = 1;
    const wetSoft = ctx.createBiquadFilter();      // 混响尾巴也压暗，听感更暖
    wetSoft.type = 'lowpass';
    wetSoft.frequency.value = 3000;

    dry.connect(soft);
    wetIn.connect(conv); conv.connect(wetSoft); wetSoft.connect(wetOut);
    wetOut.connect(soft);
    soft.connect(warm); warm.connect(air); air.connect(comp);
    comp.connect(master); master.connect(ctx.destination);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(analyser);                     // 挂在主输出上，只监听不影响声音
    specBuf = new Float32Array(analyser.frequencyBinCount);
    timeBuf = new Float32Array(analyser.fftSize);

    // 颤音：5.4Hz 正弦，输出 ±1，具体多少音分由每个音的 vibrato 增益决定
    lfo = ctx.createOscillator();
    lfo.frequency.value = 5.4;
    lfoOut = ctx.createGain();
    lfoOut.gain.value = 1;
    lfo.connect(lfoOut);
    lfo.start();
  }

  /* 每个音都要一套节点：3 个锯齿波 -> 包络 -> 低通 -> 琴身共振 -> 干/湿 */
  function voiceChain(t, attack, brightness) {
    const g = ctx.createGain();                   // 包络
    const lp = ctx.createBiquadFilter();          // 低通：起弓时慢慢打开
    lp.type = 'lowpass';
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(brightness * 0.35, t);
    lp.frequency.linearRampToValueAtTime(brightness, t + attack * 1.3);

    const body = ctx.createBiquadFilter();        // 琴身共振：木头箱体的味道
    body.type = 'peaking';
    body.frequency.value = 1200;
    body.Q.value = 0.7;
    body.gain.value = 3.4;

    const hp = ctx.createBiquadFilter();          // 只切掉最下面那点浑浊
    hp.type = 'highpass';
    hp.frequency.value = 150;

    const warm2 = ctx.createBiquadFilter();       // 再压一道高频：柔和不刺
    warm2.type = 'lowpass';
    warm2.frequency.value = 2600;
    warm2.Q.value = 0.4;

    g.connect(lp); lp.connect(warm2); warm2.connect(body); body.connect(hp);
    hp.connect(dry); hp.connect(wetIn);
    return { g, hp };
  }

  /* 一个音：慢起弓 + 尾部渐弱 + 颤音渐入 */
  function bow(freq, t, dur, gain, opts) {
    const o = opts || {};
    const attack = o.attack || 0.26;
    const chain = voiceChain(t, attack, o.bright || 3000);

    const g = chain.g;
    const peak = gain * (o.peak || 1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak * 0.75, t + attack * 0.6);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.linearRampToValueAtTime(peak * 0.94, t + Math.max(attack + 0.12, dur - 0.4));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);

    const vib = ctx.createGain();                 // 颤音深度（起弓后才加，像真人）
    vib.gain.setValueAtTime(0, t);
    vib.gain.linearRampToValueAtTime(o.vib == null ? 7 : o.vib, t + attack + 0.35);
    lfoOut.connect(vib);

    // 一根正弦做厚实的芯：中低频饱满才温馨
    const core = ctx.createOscillator();
    core.type = 'sine';
    core.frequency.value = freq;
    const coreG = ctx.createGain();
    coreG.gain.value = 0.34;
    core.connect(coreG); coreG.connect(g);
    core.start(t); core.stop(t + dur + 0.08);

    const detunes = o.detune || [-6, 0, 7];
    detunes.forEach((cents, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = cents;
      vib.connect(osc.detune);
      const og = ctx.createGain();
      og.gain.value = i === 1 ? 0.30 : 0.16;      // 锯齿只留一点毛边（太亮会发刺）
      osc.connect(og); og.connect(g);
      osc.start(t); osc.stop(t + dur + 0.08);
    });

    if (o.oct) {                                  // 高八度的一点泛音：玻璃般的轻透感
      const os = ctx.createOscillator();
      os.type = 'sine';
      os.frequency.value = freq * 2;
      const og = ctx.createGain();
      og.gain.value = o.oct;
      os.connect(og); og.connect(g);
      os.start(t); os.stop(t + dur + 0.06);
    }
  }

  /* 弦乐铺底：三根音同时起弓，慢、轻 */
  function stringPad(notes, t, dur) {
    notes.forEach((n, i) => {
      bow(midi(n), t + i * 0.05, dur, 0.026, {
        attack: 0.9, bright: 1700, vib: 3.2, detune: [-11, 0, 12], peak: 0.9
      });
    });
  }

  /* 低音（大提琴那种）：厚一点、慢起 */
  function lowNote(n, t, dur) {
    bow(midi(n), t, dur, 0.038, {
      attack: 0.5, bright: 800, vib: 2.2, detune: [-4, 0, 4]
    });
  }

  function scheduleBeat(i, t) {
    const b = i % LOOP_BEATS;                     // 循环内的拍号
    const bar = Math.floor(b / 4);
    const ch = CHORDS[bar % CHORDS.length];
    scheduled++;

    if (b % 4 === 0) {                            // 每小节头：铺底 + 低音
      stringPad(ch.pad, t, BEAT * 4 + 1.2);
      lowNote(ch.bass, t, BEAT * 4 + 0.6);
    }
    // 主旋律
    for (const [at, note, len] of MELODY) {
      if (at === b) {
        bow(midi(note), t, len * BEAT * 0.98, 0.115, {
          attack: 0.26, bright: 3000, vib: 6.5, oct: 0.045
        });
      }
    }
    // 偶尔来一颗高音泛音，像呼吸
    if (b % 4 === 3 && Math.random() < 0.3) {
      const n = ch.pad[2] + 12;
      bow(midi(n), t + BEAT * 0.5, BEAT * 1.1, 0.030, { attack: 0.4, bright: 3600, vib: 8, oct: 0.07 });
    }
  }

  function pump() {
    if (!ctx) return;
    while (nextBeat < ctx.currentTime + 1.6) {    // 提前排 1.6 秒，够稳
      scheduleBeat(beatIdx, nextBeat);
      nextBeat += BEAT;
      beatIdx++;
    }
  }

  function start() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (playing) return;
    playing = true;
    beatIdx = 0;
    nextBeat = ctx.currentTime + 0.15;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(volume, ctx.currentTime + 2.5);   // 缓缓淡入
    pump();
    timer = setInterval(pump, 250);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(timer); timer = null;
    if (ctx) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2); // 缓缓淡出
    }
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (ctx && playing) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(volume, ctx.currentTime, 0.18);
    }
  }

  /* 当前输出的频谱概况：level=平均幅度，centroid=频谱重心(Hz)，peakHz=最强频点 */
  function spectrum() {
    if (!analyser) return { rms: 0, level: 0, centroid: 0, peakHz: 0, peakDb: -Infinity };
    analyser.getFloatTimeDomainData(timeBuf);       // 时域 -> 真实响度
    let sq = 0;
    for (let i = 0; i < timeBuf.length; i++) sq += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sq / timeBuf.length);
    analyser.getFloatFrequencyData(specBuf);
    const nyq = ctx.sampleRate / 2;
    let sum = 0, wsum = 0, peak = -Infinity, peakHz = 0;
    for (let i = 1; i < specBuf.length; i++) {
      const db = specBuf[i];
      if (!isFinite(db)) continue;
      const mag = Math.pow(10, db / 20);
      const hz = (i / specBuf.length) * nyq;
      sum += mag; wsum += mag * hz;
      if (db > peak) { peak = db; peakHz = hz; }
    }
    return {
      rms, rmsDb: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -Infinity,
      level: sum / (specBuf.length - 1), centroid: sum ? wsum / sum : 0, peakHz, peakDb: peak
    };
  }

  return {
    start, stop, setVolume, spectrum,
    isPlaying: () => playing,
    stats: () => ({
      playing,
      state: ctx ? ctx.state : 'none',
      scheduled,
      volume,
      bpm: BPM,
      instrument: 'violin'
    })
  };
})();
