// Auto-chart test with a synthetic band: 120 BPM drums, bass, guitar melody and a singer, each on its own track.
// Run: node tests/autochart.test.js
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const m={exports:{}};new Function('module',html.match(/<script id="core">([\s\S]*?)<\/script>/)[1])(m);const C=m.exports;
let fails=0;const ok=(c,msg)=>{console.log(c?'ok':'FAIL',msg);if(!c)fails++};
const SR=44100,DUR=24,BPM=120,SPB=60/BPM,T0=0.3,n=SR*DUR;
let seed=9;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647*2-1};
const track=()=>new Float32Array(n),hz=m=>440*Math.pow(2,(m-69)/12);
// every sound fades out over its last 20 ms, as real instruments do
const add=(x,t,dur,fn)=>{const a=Math.floor(t*SR),b=Math.min(n,a+Math.floor(dur*SR)),r=0.02*SR;for(let i=a;i<b;i++)x[i]+=fn((i-a)/SR)*Math.min(1,(b-i)/r)};
const drums=track(),bass=track(),gtr=track(),vox=track();
const beats=[];for(let t=T0;t<DUR-1;t+=SPB)beats.push(t);
beats.forEach((t,i)=>{
  if(i%2===0)add(drums,t,0.18,u=>0.9*Math.sin(2*Math.PI*(55+60*Math.exp(-u*30))*u)*Math.exp(-u*18));   // kick
  else{let lp=0;add(drums,t,0.14,u=>{lp=0.5*lp+0.5*rnd();return 0.5*(rnd()-lp)*Math.exp(-u*25)})}      // snare
  for(const h of [0,0.5]){let p=0;add(drums,t+h*SPB,0.04,u=>{const r=rnd(),v=r-p;p=r;return 0.18*v*Math.exp(-u*90)})} // hats on 8ths
  const bp=[40,43,45,47][i%4];add(bass,t,SPB*0.85,u=>0.6*(Math.sin(2*Math.PI*hz(bp)*u)+0.4*Math.sin(4*Math.PI*hz(bp)*u))*Math.min(1,u*200)*Math.exp(-u*2));
  [0,0.5].forEach((h,k)=>{const gp=[52,55,57,59,62,59,57,55][(i*2+k)%8],f=hz(gp);add(gtr,t+h*SPB,SPB*0.45,u=>0.4*(((u*f)%1)*2-1)*Math.min(1,u*300)*Math.exp(-u*4))});
});
const sung=[];for(let i=0;i+8<beats.length;i+=8)[60,62,64,65].forEach((p,k)=>{const t=beats[i]+k*0.5;sung.push({t,p});
  add(vox,t,0.46,u=>0.5*(Math.sin(2*Math.PI*hz(p)*u)+0.3*Math.sin(4*Math.PI*hz(p)*u))*Math.min(1,u*60,(0.46-u)*60))});
const src=x=>C.toMono([x],SR);

(async()=>{
  const t0=Date.now();
  const r=await C.autoChart({drums:src(drums),bass:src(bass),guitar:src(gtr),vocals:src(vox)},{lyrics:'one two three four\n'.repeat(sung.length/4)});
  console.log(`  stems: ${((Date.now()-t0)/1000).toFixed(1)}s, bpm ${r.bpm}, counts ${JSON.stringify(r.counts)}, delay ${r.delayMs}ms`);
  ok(Math.abs(r.bpm-BPM)<=1,'tempo found: '+r.bpm);
  // read it back exactly as the game would
  const ch=C.chartFromMidi(C.parseMidi(r.midi.buffer)),d=r.delayMs/1000,P=ch.parts;
  for(const k of ['drums','bass','guitar'])ok(P[k]&&['easy','medium','hard','expert'].every(x=>P[k][x]&&P[k][x].length),k+' has all four difficulties');
  ok(P.vocals&&P.vocals.notes.length>0,'vocals charted');
  const near=(list,t,tol=0.035)=>list.some(v=>Math.abs(v-t)<tol);
  const drumT=l=>P.drums.expert.filter(x=>x.lane===l).map(x=>x.t+d);
  const kicksTrue=beats.filter((_,i)=>i%2===0&&_<DUR-2),snTrue=beats.filter((_,i)=>i%2===1&&_<DUR-2);
  const rec=(truth,found)=>truth.filter(t=>near(found,t)).length/truth.length,prec=(truth,found)=>{const f=found.filter(t=>t<DUR-2);return f.filter(t=>near(truth,t)).length/Math.max(1,f.length)};
  const K=drumT(0),S=drumT(1);
  ok(rec(kicksTrue,K)>0.85&&prec(kicksTrue,K)>0.85,`kick drum: ${(100*rec(kicksTrue,K)|0)}% found, ${(100*prec(kicksTrue,K)|0)}% correct`);
  ok(rec(snTrue,S)>0.85&&prec(snTrue,S)>0.8,`snare: ${(100*rec(snTrue,S)|0)}% found, ${(100*prec(snTrue,S)|0)}% correct`);
  const hatTrue=beats.flatMap(t=>[t,t+SPB/2]).filter(t=>t<DUR-2),H=drumT(2);
  ok(rec(hatTrue,H)>0.7,`hi-hat: ${(100*rec(hatTrue,H)|0)}% found`);
  // timing: every expert drum note sits on a real hit
  const allHits=[...kicksTrue,...snTrue,...hatTrue],dt=P.drums.expert.map(x=>x.t+d).map(t=>Math.min(...allHits.map(h=>Math.abs(h-t))));
  ok(dt.sort((a,b)=>a-b)[dt.length>>1]<0.02,`drum timing median error ${(1000*dt[dt.length>>1]).toFixed(0)} ms`);
  // guitar frets follow the melody: higher note, higher fret
  const G=P.guitar.expert;const gtrNotes=[];beats.forEach((t,i)=>[0,0.5].forEach((h,k)=>gtrNotes.push({t:t+h*SPB,p:[52,55,57,59,62,59,57,55][(i*2+k)%8]})));
  const pairs=G.map(g=>{const tt=g.t+d,c=gtrNotes.find(q=>Math.abs(q.t-tt)<0.04);return c?[c.p,g.lanes[0]]:null}).filter(Boolean);
  const corr=(a,b)=>{const ma=a.reduce((x,y)=>x+y)/a.length,mb=b.reduce((x,y)=>x+y)/b.length;let s=0,sa=0,sb=0;for(let i=0;i<a.length;i++){s+=(a[i]-ma)*(b[i]-mb);sa+=(a[i]-ma)**2;sb+=(b[i]-mb)**2}return s/Math.sqrt(sa*sb)};
  ok(pairs.length>0.8*gtrNotes.filter(q=>q.t<DUR-2).length,`guitar notes found: ${pairs.length}/${gtrNotes.filter(q=>q.t<DUR-2).length}`);
  const cg=corr(pairs.map(p=>p[0]),pairs.map(p=>p[1]));ok(cg>0.8,`guitar frets follow the melody (correlation ${cg.toFixed(2)})`);
  const B=P.bass.expert,bp=B.map(b=>{const tt=b.t+d,i=beats.findIndex(q=>Math.abs(q-tt)<0.04);return i<0?null:[[40,43,45,47][i%4],b.lanes[0]]}).filter(Boolean);
  const bassIn=B.filter(b=>b.t+d<DUR-2).length,bassOk=bp.filter(()=>true).length;
  ok(bp.length>0.8*beats.filter(t=>t<DUR-2).length&&corr(bp.map(p=>p[0]),bp.map(p=>p[1]))>0.8,`bass notes ${bp.length}, frets follow the line`);
  ok(bassIn<=1.15*beats.filter(t=>t<DUR-2).length,`bass: no extra notes from note endings (${bassIn} charted for ${beats.filter(t=>t<DUR-2).length} played)`);
  // vocals: right pitch, right time, lyrics in place
  const V=P.vocals.notes.map(v=>({...v,t:v.t+d}));
  const vm=sung.map(sg=>V.find(v=>Math.abs(v.t-sg.t)<0.06)),found=vm.filter(Boolean).length;
  ok(found>=0.85*sung.length,`sung notes found: ${found}/${sung.length}`);
  ok(vm.every((v,i)=>!v||Math.abs(v.pitch-sung[i].p)<=1),'sung pitches correct within a semitone');
  ok(V.slice(0,4).map(v=>v.lyric).join(' ')==='one two three four','lyrics placed on the notes');
  ok(P.vocals.phrases.length===sung.length/4,`vocal phrases: ${P.vocals.phrases.length}`);
  // a whole mixed song: rough, but the beat and kick should still be right
  const mixed=new Float32Array(n);for(const x of [drums,bass,gtr,vox])for(let i=0;i<n;i++)mixed[i]+=x[i];
  const t1=Date.now(),rm=await C.autoChart({mix:src(mixed)});
  const cm=C.chartFromMidi(C.parseMidi(rm.midi.buffer)),dm=rm.delayMs/1000,Km=cm.parts.drums.expert.filter(x=>x.lane===0).map(x=>x.t+dm);
  console.log(`  full mix: ${((Date.now()-t1)/1000).toFixed(1)}s, bpm ${rm.bpm}, counts ${JSON.stringify(rm.counts)}`);
  ok(Math.abs(rm.bpm-BPM)<=1,'full mix: tempo found');
  ok(rec(kicksTrue,Km)>0.7,`full mix: kick ${(100*rec(kicksTrue,Km)|0)}% found`);
  ok(!cm.parts.vocals,'full mix: no fake vocals');
  // guessing the singing from a stereo full song: singer in the centre with vibrato, guitar panned to one side,
  // bass and drums centred, guitar still playing between the sung phrases
  {const voice=track();for(const sg of sung){const f=hz(sg.p);let ph=0;add(voice,sg.t,0.46,u=>{ph+=2*Math.PI*f*(1+0.012*Math.sin(2*Math.PI*5.5*u))/SR;
      let v=0;for(let h=1;h<=6;h++)v+=Math.sin(h*ph)/(h*h*0.7+0.3);return 0.45*v*Math.min(1,u*40)})}
   const L=new Float32Array(n),Rr=new Float32Array(n);for(let i=0;i<n;i++){const ctr=drums[i]*0.7+bass[i]*0.8+voice[i];L[i]=ctr+gtr[i]*0.85;Rr[i]=ctr+gtr[i]*0.25}
   const t2=Date.now(),rg=await C.autoChart({mix:C.toMono([L,Rr],SR),mixLR:C.toStereo([L,Rr],SR)},{guessVocals:true,lyrics:''});
   const cg2=C.chartFromMidi(C.parseMidi(rg.midi.buffer)),dg=rg.delayMs/1000,GV=cg2.parts.vocals?cg2.parts.vocals.notes.map(v=>({...v,t:v.t+dg,end:v.end+dg})):[];
   const hitsG=sung.filter(sg=>GV.some(v=>Math.abs(v.t-sg.t)<0.12&&Math.abs(v.pitch-sg.p)<=1)).length;
   const inVoice=GV.filter(v=>sung.some(sg=>v.t<sg.t+0.46&&v.end>sg.t)).length;
   console.log(`  guessed singing: ${((Date.now()-t2)/1000).toFixed(1)}s, ${GV.length} notes`);if(process.env.DBG){console.log("  sung:   ",sung.map(s=>s.t.toFixed(2)+":"+s.p).join(" "));console.log("  guessed:",GV.map(v=>v.t.toFixed(2)+"-"+v.end.toFixed(2)+":"+v.pitch).join(" "))}
   ok(rg.vocalsGuessed,'full song: singing guessed');
   ok(hitsG>=0.7*sung.length,`guessed notes match the singer: ${hitsG}/${sung.length} at the right time and pitch`);
   ok(GV.length&&inVoice/GV.length>=0.8,`guessed notes fall where someone sings: ${inVoice}/${GV.length}`);}
  // zip round trip
  const zp=C.writeZip([{name:'Band - Song/notes.mid',data:r.midi},{name:'Band - Song/song.ini',data:new TextEncoder().encode('[song]\nname = Song\n')}]);
  const blob=new Blob(zp),entries=await C.readZip(blob);
  ok(entries.length===2&&new Uint8Array(await entries[0].arrayBuffer()).length===r.midi.length,'zip round trip');
  if(process.argv[2]){fs.writeFileSync(process.argv[2],Buffer.concat(zp.map(p=>Buffer.from(p))));console.log('  wrote',process.argv[2])}
  console.log(fails?fails+' FAILED':'ALL PASS');
})();
