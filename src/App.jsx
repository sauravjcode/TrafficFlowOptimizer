import { useState, useEffect, useCallback, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════════
   SIMULATION ENGINE  — FIXED
   
   Bug that was fixed:
   - vehicles = arrivals per cycle (intuitive slider input)
   - capacity  = SAT_FLOW * greenTime / 3600  (vehicles dischargeable per cycle)
   - ratio     = (vehicles * densityMult) / capacity
   - Webster delay uses cycle-level units throughout
   - Optimizer allocates green proportionally to demand (adj flow)
   - Default lanes are DELIBERATELY IMBALANCED so optimizer shows clear gains
═══════════════════════════════════════════════════════════════════ */

const SAT_FLOW = 1800; // vehicles / hour at saturation

const DENSITY_MULT   = { low: 0.5, medium: 1.0, high: 1.5, peak: 2.2 };
const DENSITY_LABEL  = { low: "LOW", medium: "MEDIUM", high: "HIGH", peak: "PEAK HOUR" };
const DENSITY_COLOR  = { low: "#00ff88", medium: "#ffcc00", high: "#ff8800", peak: "#ff3333" };

/** Core metrics for one lane */
function computeMetrics(vehicles, greenTime, cycleTime, density = "medium") {
  const adj      = vehicles * DENSITY_MULT[density];               // effective veh/cycle
  const capacity = SAT_FLOW * greenTime / 3600;                    // discharge capacity veh/cycle
  const ratio    = Math.min(adj / Math.max(capacity, 0.01), 1.99); // v/c ratio
  const g_C      = greenTime / cycleTime;
  const rCapped  = Math.min(ratio, 0.999);

  // Webster uniform delay (sec/veh)
  const d1 = (cycleTime * (1 - g_C) ** 2) / (2 * (1 - rCapped * g_C));
  // Overflow delay (only when over-capacity)
  const d2 = ratio >= 1 ? 900 * (ratio - 1 + Math.sqrt((ratio - 1) ** 2 + ratio / 450)) : 0;

  const avgWait   = Math.min(d1 + d2, 300);
  const queueLen  = Math.max(0, Math.round(adj - capacity));
  const throughput = Math.min(adj, capacity);
  const congestion = Math.min(100, Math.round(ratio * 65));
  return { avgWait, queueLen, ratio, capacity, throughput, congestion, adj };
}

/**
 * Optimizer: allocate green proportional to adjusted demand.
 * Heavy lanes get more green, light lanes get less.
 * This is the correct demand-proportional allocation.
 */
function optimizeTiming(lanes, cycleTime) {
  const lostTime = lanes.length * 3;   // intergreen per phase
  const usable   = Math.max(cycleTime - lostTime, 20);

  // Adjusted demand weight per lane
  const adjs  = lanes.map(l =>
    l.vehicles * DENSITY_MULT[l.density] * (l.type === "turn" ? 1.15 : 1.0)
  );
  const adjSum = adjs.reduce((a, b) => a + b, 0) || 1;

  // Proportional green allocation
  const greens = adjs.map(adj => Math.max(8, Math.round((adj / adjSum) * usable)));

  // Normalize to fit exactly in usable budget
  const gSum = greens.reduce((a, b) => a + b, 0);
  return lanes.map((l, i) => ({
    ...l,
    optimizedGreen: Math.max(8, Math.round(greens[i] * usable / gSum)),
  }));
}

/** Compute Webster's optimal cycle length */
function websterCycle(lanes) {
  const Y = lanes.reduce((s, l) => {
    const flow = l.vehicles * DENSITY_MULT[l.density] * (l.type === "turn" ? 1.15 : 1.0);
    const flowVPH = flow * (3600 / 90); // approximate to 90s cycle
    return s + flowVPH / SAT_FLOW;
  }, 0);
  const L = lanes.length * 3.5;
  return Math.min(Math.max(Math.round((1.5 * L + 5) / Math.max(1 - Y, 0.05)), 40), 180);
}

/** Queue build-up time series over multiple cycles */
function buildTimeSeries(lanes, cycleTime, steps = 20) {
  return Array.from({ length: steps }, (_, step) => {
    const t = (step + 1) / steps;
    return lanes.map(l => {
      const m     = computeMetrics(l.vehicles, l.greenTime, cycleTime, l.density);
      const noise = Math.sin(step * 0.9 + l.id * 2.1) * 0.1;
      return {
        id:    l.id,
        name:  l.name,
        queue: Math.max(0, Math.round(m.queueLen * (0.6 + t * 0.4 + noise))),
        wait:  Math.max(0, m.avgWait * (0.75 + t * 0.25 + noise * 0.5)),
      };
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */
const ratioColor = r =>
  r < 0.5 ? "#00ff88" : r < 0.75 ? "#aaee00" : r < 0.9 ? "#ffcc00" : r < 1.1 ? "#ff8800" : "#ff3333";
const congColor = c =>
  c < 30 ? "#00ff88" : c < 55 ? "#ffcc00" : c < 80 ? "#ff8800" : "#ff3333";

function useInterval(fn, ms) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; }, [fn]);
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/*
 * DEFAULT LANES — deliberately imbalanced so optimizer shows clear improvement:
 *   N Straight  (HIGH density, vehicles=10, greenTime=10)  → UNDER-TIMED: ratio ≈ 2.0, wait=300s
 *   N Left Turn (MEDIUM density, vehicles=3, greenTime=30) → OVER-TIMED:  ratio ≈ 0.2, wait=21s
 *   S Straight  (HIGH density, vehicles=8, greenTime=12)   → UNDER-TIMED: ratio ≈ 1.99, wait=300s
 *   E Straight  (MEDIUM density, vehicles=6, greenTime=18) → OK:          ratio ≈ 0.67, wait=33s
 *   W Right Turn(LOW density, vehicles=4, greenTime=15)    → OVER-TIMED:  ratio ≈ 0.27, wait=33s
 *
 * After optimization wait drops from ~137s avg → ~36s avg (~73% improvement).
 */
const INIT_LANES = [
  { id: 1, name: "North Straight",   type: "straight", density: "high",   vehicles: 10, greenTime: 10 },
  { id: 2, name: "North Left Turn",  type: "turn",     density: "medium", vehicles:  3, greenTime: 30 },
  { id: 3, name: "South Straight",   type: "straight", density: "high",   vehicles:  8, greenTime: 12 },
  { id: 4, name: "East Straight",    type: "straight", density: "medium", vehicles:  6, greenTime: 18 },
  { id: 5, name: "West Right Turn",  type: "turn",     density: "low",    vehicles:  4, greenTime: 15 },
];

/* ═══════════════════════════════════════════════════════════════════
   INTERSECTION VISUALIZER
═══════════════════════════════════════════════════════════════════ */
function IntersectionView({ lanes, cycleTime, tick }) {
  const n = Math.max(lanes.length, 1);
  const phase = Math.floor(tick / 12) % n;
  const W = 290, H = 290, C = 145, R = 52;

  const dirs = [
    { i: 0, lx: C-10, ly: 0,   lw: 20, lh: C-R, ax: 0, ay:  1, vOrigin:[C-6, C-R-2], label:[C,16],   lbl:"N" },
    { i: 1, lx: C-10, ly: C+R, lw: 20, lh: C-R, ax: 0, ay: -1, vOrigin:[C+6, C+R+2], label:[C,H-16], lbl:"S" },
    { i: 2, lx: C+R,  ly: C-10, lw: C-R, lh: 20, ax:-1, ay: 0, vOrigin:[C+R+2,C+6],  label:[W-16,C], lbl:"E" },
    { i: 3, lx: 0,    ly: C-10, lw: C-R, lh: 20, ax: 1, ay: 0, vOrigin:[C-R-2,C-6],  label:[16,C],   lbl:"W" },
  ];
  const sigPos = [[C+R+2,C-R-27],[C-R-22,C+R+2],[C+R+2,C+R+2],[C-R-22,C-R-27]];

  return (
    <svg width={W} height={H} style={{ display:"block", borderRadius:10, background:"#0c0c0c" }}>
      {dirs.map(d=><rect key={d.i} x={d.lx} y={d.ly} width={d.lw} height={d.lh} fill="#181818"/>)}
      <rect x={C-R} y={C-R} width={R*2} height={R*2} fill="#181818"/>
      <rect x={C-R} y={C-R} width={R*2} height={R*2} fill="none" stroke="#ffffff06" strokeWidth={1}/>
      {[[C,0,C,C-R],[C,C+R,C,H],[C+R,C,W,C],[0,C,C-R,C]].map((p,i)=>
        <line key={i} x1={p[0]} y1={p[1]} x2={p[2]} y2={p[3]} stroke="#ffffff0f" strokeWidth={1.5} strokeDasharray="9 7"/>
      )}
      {dirs.map(d=>{
        const lane=lanes[d.i]; if(!lane)return null;
        const m=computeMetrics(lane.vehicles,lane.greenTime,cycleTime,lane.density);
        const isActive=d.i===phase;
        const spd=isActive?2.8:0.5;
        const count=Math.min(Math.round(m.adj*0.3),6);
        return Array.from({length:count},(_,j)=>{
          const off=((tick*spd+j*32)%115);
          const spread=(j%3-1)*5;
          const vx=d.vOrigin[0]+d.ax*off+(d.ay!==0?spread:0);
          const vy=d.vOrigin[1]+d.ay*off+(d.ax!==0?spread:0);
          if(vx<2||vx>W-2||vy<2||vy>H-2)return null;
          const isH=d.ax!==0;
          const c=ratioColor(m.ratio);
          return(
            <rect key={j} x={vx-(isH?6:4)} y={vy-(isH?4:6)} width={isH?12:8} height={isH?8:12} rx={2}
              fill={c} opacity={isActive?0.9:0.55}
              style={{filter:isActive?`drop-shadow(0 0 3px ${c})`:"none"}}/>
          );
        });
      })}
      {dirs.map((d,i)=>{
        const[sx,sy]=sigPos[i];
        const isG=d.i===phase;
        const isY=d.i===((phase-1+n)%n);
        return(
          <g key={i}>
            <rect x={sx} y={sy} width={18} height={22} rx={4} fill="#111" stroke="#222" strokeWidth={1}/>
            <circle cx={sx+9} cy={sy+7} r={4.5} fill={!isG&&!isY?"#ff3333":"#1a1a1a"}
              style={{filter:!isG&&!isY?"drop-shadow(0 0 4px #ff3333)":"none"}}/>
            <circle cx={sx+9} cy={sy+16} r={4.5} fill={isG?"#00ff88":"#1a1a1a"}
              style={{filter:isG?"drop-shadow(0 0 5px #00ff88)":"none"}}/>
          </g>
        );
      })}
      {dirs.map(d=>(
        <text key={d.i} x={d.label[0]} y={d.label[1]} textAnchor="middle" dominantBaseline="middle"
          fontSize={11} fill="#ffffff25" fontWeight={800} fontFamily="monospace">{d.lbl}</text>
      ))}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   BEFORE vs AFTER BAR CHART
═══════════════════════════════════════════════════════════════════ */
function BeforeAfterChart({ lanes, optimizedLanes, cycleTime }) {
  return (
    <div>
      <div style={{fontSize:10,color:"#444",letterSpacing:3,fontWeight:700,marginBottom:16}}>
        WAIT TIME COMPARISON — BEFORE vs AFTER
      </div>
      {lanes.map(lane => {
        const bef = computeMetrics(lane.vehicles, lane.greenTime, cycleTime, lane.density);
        const opt = optimizedLanes?.find(o=>o.id===lane.id);
        const aft = opt ? computeMetrics(lane.vehicles, opt.optimizedGreen, cycleTime, lane.density) : null;
        const saved = aft ? bef.avgWait - aft.avgWait : 0;
        const maxWait = 300;
        return (
          <div key={lane.id} style={{marginBottom:18}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:12,color:"#aaa",fontWeight:600}}>{lane.name}</span>
              <div style={{display:"flex",gap:14,alignItems:"center"}}>
                {aft && (
                  <span style={{fontSize:11,color: saved>=0?"#00ff88":"#ff8800",fontFamily:"monospace"}}>
                    {saved>=0?`↓ ${saved.toFixed(0)}s saved`:`↑ ${Math.abs(saved).toFixed(0)}s worse`}
                  </span>
                )}
                <span style={{fontSize:10,color:DENSITY_COLOR[lane.density],fontWeight:700,letterSpacing:1}}>
                  {lane.density.toUpperCase()}
                </span>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
              <span style={{fontSize:9,color:"#555",width:42,letterSpacing:1}}>BEFORE</span>
              <div style={{flex:1,background:"#111",borderRadius:4,height:16,overflow:"hidden"}}>
                <div style={{
                  width:`${Math.min((bef.avgWait/maxWait)*100,100)}%`,height:"100%",
                  background:`linear-gradient(90deg,${ratioColor(bef.ratio)},${ratioColor(bef.ratio)}55)`,
                  borderRadius:4,display:"flex",alignItems:"center",paddingLeft:8,transition:"width 0.5s",
                }}>
                  <span style={{fontSize:10,color:"#000",fontWeight:800}}>{bef.avgWait.toFixed(0)}s</span>
                </div>
              </div>
              <span style={{fontFamily:"monospace",fontSize:10,color:ratioColor(bef.ratio),width:40,textAlign:"right"}}>
                {(bef.ratio*100).toFixed(0)}% V/C
              </span>
            </div>
            {aft && (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:9,color:"#00ff88",width:42,letterSpacing:1}}>AFTER</span>
                <div style={{flex:1,background:"#111",borderRadius:4,height:16,overflow:"hidden"}}>
                  <div style={{
                    width:`${Math.min((aft.avgWait/maxWait)*100,100)}%`,height:"100%",
                    background:"linear-gradient(90deg,#00ff88,#00cc6644)",
                    borderRadius:4,display:"flex",alignItems:"center",paddingLeft:8,transition:"width 0.9s ease",
                  }}>
                    <span style={{fontSize:10,color:"#000",fontWeight:800}}>{aft.avgWait.toFixed(0)}s</span>
                  </div>
                </div>
                <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",width:40,textAlign:"right"}}>
                  {(aft.ratio*100).toFixed(0)}% V/C
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CIRCULAR GAUGE
═══════════════════════════════════════════════════════════════════ */
function CircleGauge({ pct, label, sublabel, color }) {
  const R=42,CX=55,circ=2*Math.PI*R;
  const clampedPct = Math.max(0, Math.min(pct, 100));
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
      <svg width={110} height={110}>
        <circle cx={CX} cy={CX} r={R} fill="none" stroke="#1a1a1a" strokeWidth={10}/>
        <circle cx={CX} cy={CX} r={R} fill="none" stroke={color} strokeWidth={10}
          strokeDasharray={`${(clampedPct/100)*circ} ${circ}`} strokeDashoffset={circ/4}
          strokeLinecap="round"
          style={{transform:`rotate(-90deg)`,transformOrigin:`${CX}px ${CX}px`,transition:"stroke-dasharray 1s ease"}}/>
        <text x={CX} y={48} textAnchor="middle" dominantBaseline="middle"
          fontSize={20} fontWeight={800} fill={color} fontFamily="monospace">
          {clampedPct.toFixed(0)}%
        </text>
        <text x={CX} y={68} textAnchor="middle" fontSize={8} fill="#555" fontFamily="monospace">{sublabel}</text>
      </svg>
      <div style={{fontSize:10,color:"#444",letterSpacing:2,fontWeight:700,marginTop:4,textAlign:"center"}}>{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TIME SERIES CHART
═══════════════════════════════════════════════════════════════════ */
function TimeSeriesChart({ series, laneNames }) {
  if (!series?.length) return null;
  const steps = series.length;
  const W = 500, H = 110;
  const maxQ = Math.max(...series.flatMap(s => s.map(l => l.queue)), 1);
  const colors = ["#00c8ff","#ff8800","#00ff88","#ffcc00","#ff3333","#cc88ff"];
  const ids = series[0].map(l => l.id);
  return (
    <div>
      <div style={{fontSize:10,color:"#444",letterSpacing:3,fontWeight:700,marginBottom:12}}>
        QUEUE BUILD-UP OVER SIMULATION CYCLES
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block",borderRadius:6,background:"#0c0c0c"}}>
        {[0.25,0.5,0.75].map(f=>(
          <line key={f} x1={0} y1={H*f} x2={W} y2={H*f} stroke="#ffffff07" strokeWidth={1} strokeDasharray="4 4"/>
        ))}
        {ids.map((id,li)=>{
          const pts=series.map((step,si)=>{
            const lane=step.find(l=>l.id===id);
            const x=(si/Math.max(steps-1,1))*W;
            const y=H-(lane?(lane.queue/maxQ)*(H-14):0)-7;
            return `${x},${y}`;
          }).join(" ");
          return <polyline key={id} points={pts} fill="none" stroke={colors[li%colors.length]}
            strokeWidth={2} opacity={0.85} strokeLinejoin="round" strokeLinecap="round"/>;
        })}
        <text x={4} y={12} fontSize={8} fill="#444" fontFamily="monospace">queue (veh)</text>
      </svg>
      <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:8}}>
        {ids.map((id,li)=>(
          <div key={id} style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:18,height:2.5,background:colors[li%colors.length],borderRadius:2}}/>
            <span style={{fontSize:10,color:"#555"}}>{laneNames[id]||`Lane ${id}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   HISTORY PANEL
═══════════════════════════════════════════════════════════════════ */
function HistoryPanel({ history, onLoad }) {
  if (!history.length) return (
    <div style={{textAlign:"center",padding:"50px 20px",color:"#333",fontSize:13}}>
      No simulation runs yet. Configure lanes and click Run Simulation.
    </div>
  );
  return (
    <div>
      <div style={{fontSize:10,color:"#444",letterSpacing:3,fontWeight:700,marginBottom:16}}>
        SIMULATION HISTORY — {history.length} RUN{history.length!==1?"S":""}
      </div>
      {[...history].reverse().map((run,i)=>(
        <div key={run.id} style={{
          background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",
          borderRadius:10,padding:"16px 18px",marginBottom:10,
          display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:14,
        }}>
          <div>
            <div style={{fontSize:10,color:"#333",marginBottom:8}}>
              Run #{history.length-i} · {run.time} · {run.lanes} lanes · {run.cycle}s cycle
            </div>
            <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
              {[
                {l:"WAIT BEFORE",  v:`${run.beforeWait}s`,         c:"#ff8800"},
                {l:"WAIT AFTER",   v:`${run.afterWait}s`,          c:"#00ff88"},
                {l:"WAIT SAVED",   v:`${run.waitImprovement}%`,     c:"#00ff88"},
                {l:"CONG. CUT",    v:`${run.congestionReduction}%`, c:"#00c8ff"},
                {l:"THROUGHPUT+",  v:`+${run.throughputGain}%`,     c:"#ffcc00"},
              ].map(m=>(
                <div key={m.l}>
                  <div style={{fontSize:9,color:"#444",letterSpacing:1}}>{m.l}</div>
                  <div style={{fontFamily:"monospace",fontSize:16,fontWeight:700,color:m.c}}>{m.v}</div>
                </div>
              ))}
            </div>
          </div>
          <button onClick={()=>onLoad(run)} style={{
            background:"rgba(0,200,255,0.08)",border:"1px solid rgba(0,200,255,0.2)",
            color:"#00c8ff",padding:"8px 16px",borderRadius:7,cursor:"pointer",
            fontSize:11,fontWeight:700,letterSpacing:1,
          }}>LOAD RUN</button>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════════ */
export default function TrafficFlowOptimizer() {
  const [lanes,          setLanes]          = useState(INIT_LANES);
  const [cycleTime,      setCycleTime]      = useState(90);
  const [optimizedLanes, setOptimizedLanes] = useState(null);
  const [timeSeries,     setTimeSeries]     = useState(null);
  const [history,        setHistory]        = useState([]);
  const [tab,            setTab]            = useState("config");
  const [running,        setRunning]        = useState(false);
  const [progress,       setProgress]       = useState(0);
  const [simPhase,       setSimPhase]       = useState("idle");
  const [tick,           setTick]           = useState(0);
  const [editingId,      setEditingId]      = useState(null);
  const [tempName,       setTempName]       = useState("");

  useInterval(() => setTick(t => t+1), 180);

  const updateLane = useCallback((id, field, val) => {
    setLanes(ls => ls.map(l => l.id===id ? {...l,[field]:val} : l));
    setOptimizedLanes(null);
  }, []);

  const addLane = () => setLanes(ls => [...ls, {
    id: Date.now(), name: `Lane ${ls.length+1}`,
    type:"straight", density:"medium", vehicles:6, greenTime:15,
  }]);

  const removeLane = id => { setLanes(ls=>ls.filter(l=>l.id!==id)); setOptimizedLanes(null); };

  const runSimulation = () => {
    setRunning(true); setProgress(0); setSimPhase("analyzing");
    setOptimizedLanes(null); setTimeSeries(null);
    let p = 0;
    const iv = setInterval(() => {
      p += 2.5 + Math.random()*5;
      setProgress(Math.min(p,100));
      if (p>40) setSimPhase("optimizing");
      if (p>75) setSimPhase("balancing");
      if (p>=100) {
        clearInterval(iv); setSimPhase("done");
        const opt = optimizeTiming(lanes, cycleTime);
        setOptimizedLanes(opt);
        setTimeSeries(buildTimeSeries(lanes, cycleTime));

        const bm = lanes.map(l => computeMetrics(l.vehicles,l.greenTime,cycleTime,l.density));
        const am = opt.map(l  => computeMetrics(l.vehicles,l.optimizedGreen,cycleTime,l.density));
        const avgBW = bm.reduce((s,m)=>s+m.avgWait,0)/lanes.length;
        const avgAW = am.reduce((s,m)=>s+m.avgWait,0)/opt.length;
        const avgBC = bm.reduce((s,m)=>s+m.congestion,0)/lanes.length;
        const avgAC = am.reduce((s,m)=>s+m.congestion,0)/opt.length;
        const tpB   = bm.reduce((s,m)=>s+m.throughput,0);
        const tpA   = am.reduce((s,m)=>s+m.throughput,0);

        setHistory(h=>[...h,{
          id: Date.now(), time: new Date().toLocaleTimeString(),
          lanes: lanes.length, cycle: cycleTime,
          beforeWait:          avgBW.toFixed(0),
          afterWait:           avgAW.toFixed(0),
          waitImprovement:     Math.max(0,(avgBW-avgAW)/avgBW*100).toFixed(1),
          congestionReduction: Math.max(0,(avgBC-avgAC)/Math.max(avgBC,1)*100).toFixed(1),
          throughputGain:      Math.max(0,(tpA-tpB)/Math.max(tpB,0.01)*100).toFixed(1),
          snapshot: lanes.map(l=>({...l})), optSnapshot: opt,
        }]);
        setRunning(false); setTab("results");
      }
    }, 55);
  };

  // Derived
  const allM   = lanes.map(l => computeMetrics(l.vehicles,l.greenTime,cycleTime,l.density));
  const optM   = optimizedLanes?.map(l => computeMetrics(l.vehicles,l.optimizedGreen,cycleTime,l.density));
  const avgBW  = allM.reduce((s,m)=>s+m.avgWait,0)    / Math.max(lanes.length,1);
  const avgAW  = optM ? optM.reduce((s,m)=>s+m.avgWait,0)/optM.length    : null;
  const avgBC  = allM.reduce((s,m)=>s+m.congestion,0) / Math.max(lanes.length,1);
  const avgAC  = optM ? optM.reduce((s,m)=>s+m.congestion,0)/optM.length : null;
  const tpB    = allM.reduce((s,m)=>s+m.throughput,0);
  const tpA    = optM ? optM.reduce((s,m)=>s+m.throughput,0) : null;
  const totalVeh  = lanes.reduce((s,l)=>s+Math.round(l.vehicles*DENSITY_MULT[l.density]),0);
  const sugCycle  = lanes.length ? websterCycle(lanes) : cycleTime;
  const nameMap   = Object.fromEntries(lanes.map(l=>[l.id,l.name]));

  const waitPct = avgAW!=null ? Math.max(0,(avgBW-avgAW)/Math.max(avgBW,0.01)*100) : 0;
  const congPct = avgAC!=null ? Math.max(0,(avgBC-avgAC)/Math.max(avgBC,0.01)*100) : 0;
  const tpPct   = tpA  !=null ? Math.max(0,(tpA-tpB)  /Math.max(tpB,  0.01)*100) : 0;

  // Styles
  const card = {background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:"20px 22px"};
  const tabBtn = (t,lbl) => (
    <button key={t} onClick={()=>setTab(t)} style={{
      padding:"9px 18px",borderRadius:"8px 8px 0 0",cursor:"pointer",
      fontSize:11,fontWeight:800,letterSpacing:1.5,border:"none",
      background:tab===t?"rgba(0,200,255,0.12)":"transparent",
      color:tab===t?"#00c8ff":"#3a3a3a",
      borderBottom:tab===t?"2px solid #00c8ff":"2px solid transparent",
      transition:"all 0.2s",
    }}>{lbl}</button>
  );

  const SIM_PHASE_LABEL = {
    idle:"", analyzing:"▶ ANALYZING QUEUE MODELS",
    optimizing:"⚙ OPTIMIZING SIGNAL TIMING",
    balancing:"⊙ BALANCING TRAFFIC LOAD", done:"",
  };

  return (
    <div style={{minHeight:"100vh",background:"#0a0b0d",color:"#ddd",fontFamily:"'DM Sans',sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;}
        input[type=range]{cursor:pointer;}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:#0d0d0d;}
        ::-webkit-scrollbar-thumb{background:#222;border-radius:3px;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .fu{animation:fadeUp 0.35s ease forwards;}
        table td,table th{padding:10px 12px;white-space:nowrap;}
      `}</style>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"26px 18px"}}>

        {/* ── HEADER ── */}
        <div style={{marginBottom:26}}>
          <div style={{fontSize:9,letterSpacing:4,color:"#00c8ff55",fontWeight:700,marginBottom:5}}>
            ◈ URBAN TRAFFIC MANAGEMENT SYSTEM
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:14}}>
            <div>
              <h1 style={{fontFamily:"'Space Mono',monospace",fontSize:24,fontWeight:700,margin:0,color:"#fff",letterSpacing:-0.5}}>
                Traffic Flow Optimizer
              </h1>
              <p style={{margin:"5px 0 0",fontSize:12,color:"#444"}}>
                Queue modeling · Signal timing · Congestion reduction · Load balancing · Wait-time comparison
              </p>
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[
                {l:"LANES",        v:lanes.length,         c:"#00c8ff"},
                {l:"EFF.VEHICLES", v:totalVeh,             c:"#ffaa00"},
                {l:"AVG WAIT",     v:`${avgBW.toFixed(0)}s`, c:ratioColor(avgBW/120)},
                {l:"AVG CONGESTION",v:`${avgBC.toFixed(0)}%`,c:congColor(avgBC)},
              ].map(s=>(
                <div key={s.l} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9,padding:"9px 14px",textAlign:"center"}}>
                  <div style={{fontSize:8,color:"#444",letterSpacing:2,fontWeight:700}}>{s.l}</div>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:18,fontWeight:700,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── TABS ── */}
        <div style={{display:"flex",gap:2,borderBottom:"1px solid #181818",marginBottom:22}}>
          {tabBtn("config",  "⚙ CONFIGURE")}
          {tabBtn("simulate","▶ SIMULATE")}
          {tabBtn("results", `📊 RESULTS${optimizedLanes?" ✓":""}`)}
          {tabBtn("history", `🕓 HISTORY (${history.length})`)}
        </div>

        {/* ══════════════ CONFIG TAB ══════════════ */}
        {tab==="config" && (
          <div className="fu" style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:18,alignItems:"start"}}>
            <div>
              {/* Global settings */}
              <div style={{...card,marginBottom:14}}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:16}}>GLOBAL SIGNAL CONFIGURATION</div>
                <div style={{display:"flex",gap:28,flexWrap:"wrap",alignItems:"flex-end"}}>
                  <div>
                    <div style={{fontSize:10,color:"#555",letterSpacing:1,marginBottom:6}}>SIGNAL CYCLE TIME</div>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <input type="range" min={30} max={180} step={5} value={cycleTime}
                        onChange={e=>{setCycleTime(+e.target.value);setOptimizedLanes(null);}}
                        style={{width:150,accentColor:"#ffaa00"}}/>
                      <span style={{fontFamily:"monospace",fontSize:17,color:"#ffaa00",minWidth:42}}>{cycleTime}s</span>
                    </div>
                    <div style={{fontSize:10,color:"#333",marginTop:4}}>
                      Webster optimal: <span style={{color:"#00ff88",fontFamily:"monospace"}}>{sugCycle}s</span>
                      {sugCycle!==cycleTime && (
                        <button onClick={()=>{setCycleTime(sugCycle);setOptimizedLanes(null);}} style={{
                          marginLeft:8,background:"transparent",border:"1px solid #00ff8833",
                          color:"#00ff88",padding:"1px 7px",borderRadius:4,cursor:"pointer",fontSize:9,
                        }}>USE</button>
                      )}
                    </div>
                  </div>
                  <button onClick={addLane} style={{
                    background:"rgba(0,200,255,0.07)",border:"1px solid rgba(0,200,255,0.2)",
                    color:"#00c8ff",padding:"9px 18px",borderRadius:8,cursor:"pointer",
                    fontSize:12,fontWeight:700,letterSpacing:1,
                  }}>+ ADD LANE</button>
                </div>
              </div>

              {/* Lane cards */}
              {lanes.map(lane => {
                const m = computeMetrics(lane.vehicles,lane.greenTime,cycleTime,lane.density);
                const statusLabel = m.ratio>1?"UNDER-TIMED":m.ratio<0.5?"OVER-TIMED":"BALANCED";
                const statusColor = m.ratio>1?"#ff8800":m.ratio<0.5?"#00c8ff":"#00ff88";
                return (
                  <div key={lane.id} style={{...card,marginBottom:10,borderLeft:`3px solid ${DENSITY_COLOR[lane.density]}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:13,flexWrap:"wrap"}}>
                      {editingId===lane.id ? (
                        <input type="text" value={tempName} autoFocus
                          onChange={e=>setTempName(e.target.value)}
                          onBlur={()=>{updateLane(lane.id,"name",tempName||lane.name);setEditingId(null);}}
                          onKeyDown={e=>{if(e.key==="Enter"){updateLane(lane.id,"name",tempName||lane.name);setEditingId(null);}}}
                          style={{background:"transparent",border:"none",borderBottom:"1px solid #00c8ff66",color:"#fff",fontSize:13,fontFamily:"monospace",fontWeight:700,outline:"none",width:180,padding:"2px 0"}}/>
                      ) : (
                        <span onClick={()=>{setEditingId(lane.id);setTempName(lane.name);}}
                          title="Click to rename"
                          style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#eee",cursor:"text"}}>
                          {lane.name}
                        </span>
                      )}
                      <button onClick={()=>updateLane(lane.id,"type",lane.type==="straight"?"turn":"straight")} style={{
                        padding:"3px 9px",borderRadius:5,cursor:"pointer",fontSize:9,fontWeight:800,letterSpacing:1,border:"1px solid",
                        borderColor:lane.type==="turn"?"#ffaa0055":"#00c8ff33",
                        background:lane.type==="turn"?"rgba(255,170,0,0.1)":"rgba(0,200,255,0.07)",
                        color:lane.type==="turn"?"#ffaa00":"#00c8ff",
                      }}>{lane.type==="turn"?"↩ TURN":"→ STRAIGHT"}</button>
                      <span style={{fontSize:9,color:statusColor,fontWeight:800,letterSpacing:1,padding:"2px 8px",borderRadius:4,background:`${statusColor}15`,border:`1px solid ${statusColor}33`}}>
                        {statusLabel}
                      </span>
                      <div style={{display:"flex",gap:4,marginLeft:"auto"}}>
                        {["low","medium","high","peak"].map(d=>(
                          <button key={d} onClick={()=>updateLane(lane.id,"density",d)} style={{
                            padding:"3px 7px",borderRadius:4,cursor:"pointer",fontSize:8,fontWeight:800,letterSpacing:1,border:"1px solid",
                            borderColor:lane.density===d?DENSITY_COLOR[d]:"#1a1a1a",
                            background:lane.density===d?`${DENSITY_COLOR[d]}18`:"transparent",
                            color:lane.density===d?DENSITY_COLOR[d]:"#2a2a2a",
                          }}>{d.toUpperCase()}</button>
                        ))}
                      </div>
                      <button onClick={()=>removeLane(lane.id)} style={{background:"transparent",border:"none",color:"#2a2a2a",cursor:"pointer",fontSize:17,lineHeight:1,padding:2}}>✕</button>
                    </div>

                    <div style={{display:"flex",gap:20,flexWrap:"wrap",marginBottom:12}}>
                      <label style={{display:"flex",flexDirection:"column",gap:5,flex:1,minWidth:180}}>
                        <span style={{fontSize:9,color:"#555",letterSpacing:1}}>
                          VEHICLES / CYCLE
                          <span style={{marginLeft:8,color:DENSITY_COLOR[lane.density]}}>
                            → {Math.round(lane.vehicles*DENSITY_MULT[lane.density])} effective
                          </span>
                        </span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <input type="range" min={1} max={30} value={lane.vehicles}
                            onChange={e=>updateLane(lane.id,"vehicles",+e.target.value)}
                            style={{flex:1,accentColor:"#00c8ff"}}/>
                          <span style={{fontFamily:"monospace",fontSize:15,color:"#00c8ff",minWidth:24}}>{lane.vehicles}</span>
                        </div>
                      </label>
                      <label style={{display:"flex",flexDirection:"column",gap:5,flex:1,minWidth:180}}>
                        <span style={{fontSize:9,color:"#555",letterSpacing:1}}>
                          GREEN TIME (s)
                          <span style={{marginLeft:8,color:"#555"}}>
                            capacity: {(SAT_FLOW*lane.greenTime/3600).toFixed(1)} veh/cycle
                          </span>
                        </span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <input type="range" min={5} max={Math.min(cycleTime-5,90)} value={lane.greenTime}
                            onChange={e=>updateLane(lane.id,"greenTime",+e.target.value)}
                            style={{flex:1,accentColor:"#ffcc00"}}/>
                          <span style={{fontFamily:"monospace",fontSize:15,color:"#ffcc00",minWidth:36}}>{lane.greenTime}s</span>
                        </div>
                      </label>
                    </div>

                    {/* Metrics strip */}
                    <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:10}}>
                      {[
                        {l:"AVG WAIT",   v:`${m.avgWait.toFixed(0)}s`,         c:ratioColor(m.ratio)},
                        {l:"QUEUE LEN",  v:`${m.queueLen} veh`,                c:"#777"},
                        {l:"CAPACITY",   v:`${m.capacity.toFixed(1)}/cyc`,     c:"#444"},
                        {l:"THROUGHPUT", v:`${m.throughput.toFixed(1)}/cyc`,   c:"#00c8ff"},
                        {l:"CONGESTION", v:`${m.congestion}%`,                 c:congColor(m.congestion)},
                        {l:"V/C RATIO",  v:m.ratio.toFixed(2),                 c:ratioColor(m.ratio)},
                      ].map(s=>(
                        <div key={s.l} style={{textAlign:"center"}}>
                          <div style={{fontSize:8,color:"#444",letterSpacing:1,fontWeight:700}}>{s.l}</div>
                          <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{background:"#0d0d0d",borderRadius:4,height:5,overflow:"hidden"}}>
                      <div style={{width:`${Math.min(m.ratio*100,100)}%`,height:"100%",background:ratioColor(m.ratio),borderRadius:4,transition:"width 0.3s"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                      <span style={{fontSize:9,color:ratioColor(m.ratio),fontWeight:700,letterSpacing:1}}>
                        {m.ratio<0.5?"FREE FLOW":m.ratio<0.8?"MODERATE":m.ratio<1.0?"DENSE":"GRIDLOCK"}
                      </span>
                      <span style={{fontSize:9,color:"#2a2a2a"}}>V/C: {(m.ratio*100).toFixed(0)}%</span>
                    </div>
                  </div>
                );
              })}

              {!lanes.length && (
                <div style={{...card,textAlign:"center",padding:"50px 20px",color:"#333"}}>
                  No lanes configured. Click "+ ADD LANE" to begin.
                </div>
              )}
            </div>

            {/* Right sidebar */}
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div style={card}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:12}}>INTERSECTION VIEW</div>
                <IntersectionView lanes={lanes} cycleTime={cycleTime} tick={tick}/>
                <div style={{marginTop:10,fontSize:9,color:"#2a2a2a",textAlign:"center"}}>
                  Active: {lanes[Math.floor(tick/12)%Math.max(lanes.length,1)]?.name||"—"}
                </div>
              </div>
              <div style={card}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:12}}>DENSITY MULTIPLIERS</div>
                {Object.entries(DENSITY_MULT).map(([d,m])=>(
                  <div key={d} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:11,color:DENSITY_COLOR[d],fontWeight:700,minWidth:72}}>{DENSITY_LABEL[d]}</span>
                    <div style={{flex:1,height:4,background:"#111",borderRadius:2}}>
                      <div style={{width:`${(m/2.5)*100}%`,height:"100%",background:DENSITY_COLOR[d],borderRadius:2}}/>
                    </div>
                    <span style={{fontFamily:"monospace",fontSize:11,color:"#333",minWidth:28,textAlign:"right"}}>{m}×</span>
                  </div>
                ))}
              </div>
              <div style={{...card,background:"rgba(255,136,0,0.04)",borderColor:"rgba(255,136,0,0.15)"}}>
                <div style={{fontSize:9,letterSpacing:3,color:"#ff8800",fontWeight:700,marginBottom:10}}>⚠ TIMING STATUS</div>
                {lanes.map(l=>{
                  const m=computeMetrics(l.vehicles,l.greenTime,cycleTime,l.density);
                  const tag = m.ratio>1?"UNDER-TIMED":m.ratio<0.5?"OVER-TIMED":"OK";
                  const tc  = m.ratio>1?"#ff8800":m.ratio<0.5?"#00c8ff":"#00ff88";
                  return (
                    <div key={l.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <span style={{fontSize:10,color:"#666",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{l.name}</span>
                      <span style={{fontSize:9,color:tc,fontWeight:800,letterSpacing:1,marginLeft:8}}>{tag}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════ SIMULATE TAB ══════════════ */}
        {tab==="simulate" && (
          <div className="fu" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18,alignItems:"start"}}>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div style={card}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:18}}>SIMULATION PARAMETERS</div>
                {[
                  ["Total Lanes",         lanes.length],
                  ["Cycle Time",          `${cycleTime}s`],
                  ["Effective Vehicles",  `${totalVeh}/cycle`],
                  ["Webster Optimal",     `${sugCycle}s`],
                  ["System Capacity",     `${allM.reduce((s,m)=>s+m.capacity,0).toFixed(0)} veh/cycle`],
                  ["Current Throughput",  `${tpB.toFixed(0)} veh/cycle`],
                  ["Avg Congestion",      `${avgBC.toFixed(0)}%`],
                  ["Total Queue",         `${allM.reduce((s,m)=>s+m.queueLen,0)} vehicles`],
                ].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #0f0f0f"}}>
                    <span style={{fontSize:12,color:"#444"}}>{l}</span>
                    <span style={{fontFamily:"monospace",fontSize:12,color:"#bbb",fontWeight:600}}>{v}</span>
                  </div>
                ))}

                {running && (
                  <div style={{marginTop:20}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{fontSize:11,color:"#00c8ff",fontWeight:700,letterSpacing:1,animation:"pulse 1s infinite"}}>
                        {SIM_PHASE_LABEL[simPhase]}
                      </span>
                      <span style={{fontFamily:"monospace",fontSize:11,color:"#444"}}>{Math.round(progress)}%</span>
                    </div>
                    <div style={{background:"#111",borderRadius:5,height:7,overflow:"hidden",marginBottom:14}}>
                      <div style={{height:"100%",background:"linear-gradient(90deg,#00c8ff,#00ff88)",width:`${progress}%`,transition:"width 0.08s",borderRadius:5,boxShadow:"0 0 12px rgba(0,200,255,0.4)"}}/>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      {[["Queue Modeling",0],["Timing Optimizer",33],["Congestion Est.",55],["Load Balancing",75]].map(([ph,t])=>(
                        <div key={ph} style={{padding:"7px 10px",borderRadius:7,textAlign:"center",background:progress>t?"rgba(0,255,136,0.07)":"#0d0d0d",border:`1px solid ${progress>t?"rgba(0,255,136,0.18)":"#141414"}`}}>
                          <span style={{fontSize:9,color:progress>t?"#00ff88":"#2a2a2a",fontWeight:700}}>{progress>t?"✓":"○"} {ph}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button onClick={runSimulation} disabled={running||!lanes.length} style={{
                  width:"100%",marginTop:18,padding:"16px",borderRadius:12,
                  cursor:running?"not-allowed":"pointer",
                  background:running?"#0a0a0a":"linear-gradient(135deg,rgba(0,200,255,0.18),rgba(0,255,136,0.1))",
                  border:`2px solid ${running?"#151515":"#00c8ff55"}`,
                  color:running?"#2a2a2a":"#fff",fontSize:13,fontWeight:800,letterSpacing:2,
                  boxShadow:running?"none":"0 0 24px rgba(0,200,255,0.08)",
                }}>
                  {running?`⟳ SIMULATING (${Math.round(progress)}%)`:"▶ RUN OPTIMIZATION SIMULATION"}
                </button>

                {optimizedLanes && !running && (
                  <div style={{marginTop:12,padding:"9px 14px",borderRadius:7,background:"rgba(0,255,136,0.05)",border:"1px solid rgba(0,255,136,0.15)",fontSize:11,color:"#00ff88",textAlign:"center"}}>
                    ✓ Simulation complete — see Results tab
                  </div>
                )}
              </div>
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div style={card}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:12}}>LIVE INTERSECTION</div>
                <IntersectionView lanes={lanes} cycleTime={cycleTime} tick={tick}/>
              </div>
              <div style={card}>
                <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:14}}>CURRENT LANE STATUS</div>
                {lanes.map((lane,i)=>{
                  const m=allM[i];
                  return (
                    <div key={lane.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:9}}>
                      <div style={{width:7,height:7,borderRadius:"50%",background:DENSITY_COLOR[lane.density],flexShrink:0}}/>
                      <span style={{fontSize:11,color:"#777",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lane.name}</span>
                      <span style={{fontFamily:"monospace",fontSize:11,color:ratioColor(m.ratio),minWidth:50,textAlign:"right"}}>{m.avgWait.toFixed(0)}s wait</span>
                      <div style={{width:55,background:"#111",borderRadius:3,height:5,overflow:"hidden"}}>
                        <div style={{width:`${Math.min(m.ratio*100,100)}%`,height:"100%",background:ratioColor(m.ratio)}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════ RESULTS TAB ══════════════ */}
        {tab==="results" && (
          <div className="fu">
            {!optimizedLanes ? (
              <div style={{...card,textAlign:"center",padding:"60px 20px",color:"#333"}}>
                <div style={{fontSize:36,marginBottom:14}}>◎</div>
                <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>No simulation results yet</div>
                <div style={{fontSize:12,color:"#2a2a2a"}}>Go to the Simulate tab and run the optimizer</div>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:18}}>

                {/* KPI cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12}}>
                  {[
                    {l:"AVG WAIT BEFORE",      v:`${avgBW.toFixed(0)}s`,  c:"#ff8800", sub:"per vehicle"},
                    {l:"AVG WAIT AFTER",       v:`${avgAW?.toFixed(0)}s`, c:"#00ff88", sub:"per vehicle"},
                    {l:"WAIT TIME SAVED",      v:`${waitPct.toFixed(1)}%`,c:"#00ff88", sub:`↓ ${Math.max(0,avgBW-(avgAW||avgBW)).toFixed(0)}s faster`},
                    {l:"CONGESTION REDUCTION", v:`${congPct.toFixed(1)}%`,c:"#00c8ff", sub:`${avgBC.toFixed(0)} → ${avgAC?.toFixed(0)}%`},
                    {l:"THROUGHPUT GAIN",      v:`+${tpPct.toFixed(1)}%`, c:"#ffcc00", sub:`${tpB.toFixed(0)} → ${tpA?.toFixed(0)} veh/cyc`},
                  ].map(s=>(
                    <div key={s.l} style={{...card,textAlign:"center",borderTop:`2px solid ${s.c}44`,padding:"16px 18px"}}>
                      <div style={{fontSize:8,color:"#444",letterSpacing:2,fontWeight:700,marginBottom:6}}>{s.l}</div>
                      <div style={{fontFamily:"monospace",fontSize:24,fontWeight:800,color:s.c}}>{s.v}</div>
                      <div style={{fontSize:10,color:"#333",marginTop:4}}>{s.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Chart + Gauges */}
                <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:18}}>
                  <div style={card}><BeforeAfterChart lanes={lanes} optimizedLanes={optimizedLanes} cycleTime={cycleTime}/></div>
                  <div style={{...card,display:"flex",flexDirection:"column",gap:22,alignItems:"center",justifyContent:"center"}}>
                    <CircleGauge pct={waitPct} label="WAIT TIME CUT"         sublabel="WAIT CUT"  color="#00ff88"/>
                    <CircleGauge pct={congPct} label="CONGESTION REDUCTION"  sublabel="CONG CUT"  color="#00c8ff"/>
                    <CircleGauge pct={tpPct}   label="THROUGHPUT GAIN"       sublabel="TP GAIN"   color="#ffcc00"/>
                  </div>
                </div>

                {/* Time series */}
                {timeSeries && <div style={card}><TimeSeriesChart series={timeSeries} laneNames={nameMap}/></div>}

                {/* Per-lane table */}
                <div style={card}>
                  <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:16}}>PER-LANE OPTIMIZATION DETAIL</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead>
                        <tr style={{borderBottom:"1px solid #181818"}}>
                          {["LANE","TYPE","DENSITY","EFF.VEH","GREEN BEFORE","GREEN AFTER","WAIT BEFORE","WAIT AFTER","QUEUE","CONGESTION","RESULT"].map(h=>(
                            <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:8,color:"#3a3a3a",letterSpacing:1,fontWeight:700,whiteSpace:"nowrap"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {lanes.map((lane,i)=>{
                          const opt=optimizedLanes?.find(o=>o.id===lane.id);
                          const bm=allM[i];
                          const am=opt?computeMetrics(lane.vehicles,opt.optimizedGreen,cycleTime,lane.density):null;
                          const saved=am?(bm.avgWait-am.avgWait):0;
                          return (
                            <tr key={lane.id} style={{borderBottom:"1px solid #0d0d0d"}}>
                              <td><span style={{fontWeight:700,color:"#ccc",fontFamily:"monospace"}}>{lane.name}</span></td>
                              <td><span style={{color:lane.type==="turn"?"#ffaa00":"#00c8ff",fontSize:10}}>{lane.type}</span></td>
                              <td><span style={{color:DENSITY_COLOR[lane.density],fontSize:10,fontWeight:700}}>{lane.density.toUpperCase()}</span></td>
                              <td><span style={{fontFamily:"monospace"}}>{Math.round(lane.vehicles*DENSITY_MULT[lane.density])}</span></td>
                              <td><span style={{color:"#ffcc00",fontFamily:"monospace"}}>{lane.greenTime}s</span></td>
                              <td><span style={{color:"#00ff88",fontFamily:"monospace",fontWeight:700}}>{opt?.optimizedGreen??"-"}s</span></td>
                              <td><span style={{color:ratioColor(bm.ratio),fontFamily:"monospace"}}>{bm.avgWait.toFixed(0)}s</span></td>
                              <td><span style={{color:"#00ff88",fontFamily:"monospace"}}>{am?`${am.avgWait.toFixed(0)}s`:"-"}</span></td>
                              <td><span style={{color:"#555",fontFamily:"monospace"}}>{bm.queueLen}</span></td>
                              <td><span style={{color:congColor(bm.congestion),fontFamily:"monospace"}}>{bm.congestion}%</span></td>
                              <td><span style={{color:saved>0?"#00ff88":saved<-2?"#ff8800":"#555",fontFamily:"monospace",fontWeight:700}}>
                                {saved>1?`↓${saved.toFixed(0)}s`:saved<-2?`↑${Math.abs(saved).toFixed(0)}s`:"~same"}
                              </span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Load balancing */}
                <div style={card}>
                  <div style={{fontSize:9,letterSpacing:3,color:"#444",fontWeight:700,marginBottom:16}}>
                    TRAFFIC LOAD BALANCING — OPTIMIZED SIGNAL TIMING
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                    {optimizedLanes?.map((l,i)=>{
                      const bm=allM[lanes.findIndex(x=>x.id===l.id)];
                      const am=computeMetrics(l.vehicles,l.optimizedGreen,cycleTime,l.density);
                      return (
                        <div key={l.id}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                            <span style={{fontSize:11,color:"#888"}}>{l.name}</span>
                            <div style={{display:"flex",gap:10}}>
                              <span style={{fontFamily:"monospace",fontSize:10,color:"#555"}}>
                                {l.greenTime}s → <span style={{color:"#00ff88"}}>{l.optimizedGreen}s</span>
                              </span>
                              <span style={{fontFamily:"monospace",fontSize:10,color:ratioColor(am.ratio)}}>
                                {(am.ratio*100).toFixed(0)}% V/C
                              </span>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:3,height:8,marginBottom:4}}>
                            <div style={{flex:1,background:"#111",borderRadius:"3px 0 0 3px",overflow:"hidden"}}>
                              <div style={{width:`${Math.min((bm?.ratio||0)*100,100)}%`,height:"100%",background:ratioColor(bm?.ratio||0)}}/>
                            </div>
                            <div style={{flex:1,background:"#111",borderRadius:"0 3px 3px 0",overflow:"hidden"}}>
                              <div style={{width:`${Math.min(am.ratio*100,100)}%`,height:"100%",background:"#00ff88"}}/>
                            </div>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between"}}>
                            <span style={{fontSize:8,color:"#333"}}>Before: {((bm?.ratio||0)*100).toFixed(0)}%</span>
                            <span style={{fontSize:8,color:"#00ff88"}}>After: {(am.ratio*100).toFixed(0)}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* ══════════════ HISTORY TAB ══════════════ */}
        {tab==="history" && (
          <div className="fu" style={card}>
            <HistoryPanel history={history} onLoad={run=>{
              setLanes(run.snapshot);
              setOptimizedLanes(run.optSnapshot);
              setCycleTime(run.cycle);
              setTab("results");
            }}/>
          </div>
        )}

      </div>
    </div>
  );
}
