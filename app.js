import {
  PI, EPS, deg2rad, rad2deg, clamp,
  add, sub, scale, dot, norm, cross, normalize,
  RL_calc, UB_calc, makeSpiceScatteringPlaneBasis, reciprocalVectors,
  linspace, arange, interpExtrap
} from "./tas-core.js";

const $ = id => document.getElementById(id);
const instruments = new Map();
const samples = new Map();
const sampleEnvironments = new Map();

let singleCache = null;

function num(id){ return Number($(id).value); }
function checkedValue(name){
  const el=document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}
function setRadio(name,value){
  const el=document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if(el) el.checked=true;
}
function showError(err){
  $("errorBox").textContent = err instanceof Error ? err.message : String(err);
  $("errorBox").classList.remove("hidden");
}
function clearError(){ $("errorBox").classList.add("hidden"); $("errorBox").textContent=""; }
function setStatus(text){ $("status").textContent=text; }

function hklToQ(rl,hkl){
  return add(add(scale(rl.astar,hkl[0]),scale(rl.bstar,hkl[1])),scale(rl.cstar,hkl[2]));
}
function formatHKL(v){
  return v.map(x=>Math.abs(x-Math.round(x))<1e-10?String(Math.round(x)):x.toFixed(3)).join(",");
}

function isAllowedByCentering(hkl, centering){
  const rounded=hkl.map(x=>Math.round(x));

  // Centering extinction rules are defined for integer Miller indices.
  // If a generated point is not integer-valued, leave it unchanged.
  if(hkl.some((x,i)=>Math.abs(x-rounded[i])>1e-10)) return true;

  const [h,k,l]=rounded;
  const even = x => Math.abs(x)%2===0;

  switch(centering){
    case "I":
      return even(h+k+l);
    case "F":
      return (even(h) && even(k) && even(l)) ||
             (!even(h) && !even(k) && !even(l));
    case "A":
      return even(k+l);
    case "B":
      return even(h+l);
    case "C":
      return even(h+k);
    case "P":
    default:
      return true;
  }
}
function maxArray(a){ return Math.max(...a); }

async function fetchJson(url){
  const response = await fetch(url, {cache: "no-store"});

  if(!response.ok){
    throw new Error(`${url} を読み込めませんでした (HTTP ${response.status})。`);
  }

  return await response.json();
}

function normalizeJsonFileList(value){
  if(Array.isArray(value)){
    return value.map(String);
  }

  // Optional alternative manifest format:
  // { "files": ["a.json", "b.json"] }
  if(value && Array.isArray(value.files)){
    return value.files.map(String);
  }

  throw new Error("index.json は JSON ファイル名の配列、または {files:[...]} である必要があります。");
}

const GITHUB_REPO_OWNER = "Hodaka-Kikuchi";
const GITHUB_REPO_NAME = "TAS_QErange_Calc";
const GITHUB_REPO_BRANCH = "main";

function isGitHubPages(){
  return window.location.hostname.endsWith("github.io");
}

async function discoverJsonFilesFromGitHub(directory){
  const apiUrl =
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/` +
    `${GITHUB_REPO_NAME}/contents/${directory}` +
    `?ref=${encodeURIComponent(GITHUB_REPO_BRANCH)}`;

  const response = await fetch(apiUrl, {
    cache: "no-store",
    headers: {
      "Accept": "application/vnd.github+json"
    }
  });

  if(!response.ok){
    throw new Error(
      `GitHub API から ${directory}/ の一覧を取得できませんでした ` +
      `(HTTP ${response.status})。`
    );
  }

  const items = await response.json();

  if(!Array.isArray(items)){
    throw new Error(`${directory}/ の GitHub API 応答が不正です。`);
  }

  return items
    .filter(item => item && item.type === "file")
    .map(item => item.name)
    .filter(name => /\.json$/i.test(name))
    .filter(name => name.toLowerCase() !== "index.json")
    .sort((a,b)=>a.localeCompare(b));
}

async function discoverJsonFilesFromDirectoryListing(directory){
  const response = await fetch(`${directory}/`, {cache: "no-store"});

  if(!response.ok){
    throw new Error(
      `${directory}/ を読み込めませんでした。` +
      ` ディレクトリがプロジェクト内にあるか確認してください。`
    );
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const files = [...doc.querySelectorAll("a[href]")]
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(href => {
      try{
        const url = new URL(href, window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      }catch(_err){
        return null;
      }
    })
    .filter(Boolean)
    .filter(name => /\.json$/i.test(name))
    .filter(name => name.toLowerCase() !== "index.json");

  return [...new Set(files)].sort((a,b)=>a.localeCompare(b));
}

async function discoverJsonFiles(directory){
  // 1) If an index.json exists, use it. This remains supported for
  //    compatibility with other static hosting services.
  try{
    const manifestResponse = await fetch(
      `${directory}/index.json`,
      {cache: "no-store"}
    );

    if(manifestResponse.ok){
      const manifest = await manifestResponse.json();

      const files = normalizeJsonFileList(manifest)
        .filter(name => /\.json$/i.test(name))
        .filter(name => name.toLowerCase() !== "index.json");

      if(files.length > 0){
        return files.sort((a,b)=>a.localeCompare(b));
      }
    }
  }catch(_err){
    // Continue to automatic discovery.
  }

  // 2) On GitHub Pages, GitHub does not expose an HTML directory listing.
  //    Query the public GitHub Contents API instead. This means that adding
  //    a new JSON file to the repository is enough; index.json does not need
  //    to be maintained manually.
  if(isGitHubPages()){
    const files = await discoverJsonFilesFromGitHub(directory);

    if(files.length === 0){
      throw new Error(`${directory}/ に JSON ファイルがありません。`);
    }

    return files;
  }

  // 3) Local development with e.g. "python -m http.server 8888".
  //    Python exposes a directory listing, so parse that automatically.
  const files = await discoverJsonFilesFromDirectoryListing(directory);

  if(files.length === 0){
    throw new Error(
      `${directory}/ に JSON ファイルを見つけられませんでした。`
    );
  }

  return files;
}

async function loadJsonDirectory(directory, targetMap){
  targetMap.clear();

  const files = await discoverJsonFiles(directory);

  for(const filename of files){
    const obj = await fetchJson(`${directory}/${filename}`);
    const key = filename.replace(/\.json$/i, "");
    targetMap.set(key, obj);
  }

  return files.length;
}

function refreshSelect(map,select,emptyLabel){
  select.innerHTML="";
  if(emptyLabel!==null){
    const op=document.createElement("option");
    op.value=""; op.textContent=emptyLabel;
    select.appendChild(op);
  }
  [...map.entries()]
    .sort((a,b)=>(a[1].name||a[0]).localeCompare(b[1].name||b[0]))
    .forEach(([key,obj])=>{
      const op=document.createElement("option");
      op.value=key;
      op.textContent=obj.name || key;
      select.appendChild(op);
    });
}

function currentInstrument(){
  const key=$("instrumentSelect").value;
  if(!key || !instruments.has(key)) throw new Error("Instrument を選択してください。");
  return instruments.get(key);
}
function instrumentInterp(inst,lambdaHalf=false){
  if(!Array.isArray(inst.configuration) || inst.configuration.length===0){
    throw new Error("Instrument JSON に configuration 配列がありません。");
  }
  const pairs=inst.configuration.map(x=>[Number(x.Ei)*(lambdaHalf?4:1),Number(x.S2limit)])
    .sort((a,b)=>a[0]-b[0]);
  const xp=pairs.map(x=>x[0]), yp=pairs.map(x=>x[1]);
  return x=>interpExtrap(xp,yp,x);
}

function applyInstrumentDefaults(){
  if(!$("instrumentSelect").value) return;
  const inst=currentInstrument();
  const energyMode=inst.energy_mode || "Ef fixed";
  setRadio("energyMode",energyMode);
  $("energyInput").value=Number(inst.default_energy ?? 4.8);
  $("S2min").value=Number(inst.S2_min ?? inst.default_S2min ?? 8.0);
  setRadio("sense",inst.sense || "-+-");
  updateEnergyLabel();
  setStatus(`${inst.name || $("instrumentSelect").value} loaded`);
}

function applySampleEnvironmentDefaults(){
  const key=$("seSelect").value;
  if(!key || !sampleEnvironments.has(key)){
    setRadio("darkRef","Reference Q");
    for(let i=0;i<4;i++){
      $(`darkFrom${i}`).value=0;
      $(`darkTo${i}`).value=0;
      $(`darkOffset${i}`).value=0;
    }
    scheduleRecalc();
    return;
  }
  const se=sampleEnvironments.get(key);
  setRadio("darkRef",se.dark_angle_reference || "Reference Q");
  const ranges=Array.isArray(se.dark_angle_ranges)?se.dark_angle_ranges:[];
  for(let i=0;i<4;i++){
    const r=ranges[i] || {from:0,to:0,offset:0};
    $(`darkFrom${i}`).value=Number(r.from||0);
    $(`darkTo${i}`).value=Number(r.to||0);
    $(`darkOffset${i}`).value=Number(r.offset||0);
  }
  scheduleRecalc();
}

function updateEnergyLabel(){
  const mode=checkedValue("energyMode");
  $("energyLabel").childNodes[0].nodeValue = `${mode==="Ef fixed"?"Ef":"Ei"} (meV)`;
}
function updateModeVisibility(){
  const mode=checkedValue("sampleMode");
  const single=mode==="single";
  $("singleCrystalInputs").classList.toggle("hidden",!single);
  $("referenceSection").classList.toggle("hidden",!single);
  $("darkSection").classList.toggle("hidden",!single);
  $("senseRow").classList.toggle("hidden",!single);
  $("s1minWrap").classList.toggle("hidden",!single);
  $("s1maxWrap").classList.toggle("hidden",!single);
  $("lambdaHalf").closest("label").classList.toggle("hidden",!single);
  $("singleMain").classList.toggle("hidden",!single);
  $("powderMain").classList.toggle("hidden",single);
  $("s2Label").childNodes[0].nodeValue = single ? "S2 min (deg)" : "minimum 2θ (deg)";
}

function latticeParams(){
  return {
    a:num("a"), b:num("b"), c:num("c"),
    alpha:num("alpha"), beta:num("beta"), gamma:num("gamma")
  };
}

function getDarkRanges(){
  const rotation=num("darkRotation");
  const out=[];
  for(let i=0;i<4;i++){
    out.push([num(`darkFrom${i}`),num(`darkTo${i}`),num(`darkOffset${i}`)+rotation]);
  }
  return out;
}

function calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY){
  const kiAngle=deg2rad(-s1+s1Offset+refS1);
  const kfAngle=deg2rad(s2-s1+s1Offset+refS1);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  if(norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
  }
  return q;
}

function calcQDark(s1,s2,ki,kf,s1Offset,QrefXY,sense){
  const kiAngle=deg2rad(-s1+s1Offset);
  const kfAngle=deg2rad(s2-s1+s1Offset);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
  }
  return q;
}

function calculateSingleCrystal(){
  const inst=currentInstrument();
  const lc=latticeParams();
  const latticeCentering=$("latticeCentering").value || "P";
  const U=[num("Uh"),num("Uk"),num("Ul")];
  const V=[num("Vh"),num("Vk"),num("Vl")];
  const rl=RL_calc({...lc,sv1:U,sv2:V});
  // Keep the same UB construction as the Python implementation, even though
  // plotting below uses the explicit scattering-plane basis.
  UB_calc({...lc,sv1:U,sv2:V},rl);
  const {ex,ey,ez}=makeSpiceScatteringPlaneBasis(rl,U,V);

  const energyMode=checkedValue("energyMode");
  const lambdaHalf=$("lambdaHalf").checked;
  const energyInput=num("energyInput");
  let Ei,Ef;
  if(energyMode==="Ef fixed") Ef=lambdaHalf?4*energyInput:energyInput;
  else Ei=lambdaHalf?4*energyInput:energyInput;

  const ref=[num("refh"),num("refk"),num("refl")];
  const refS1=num("refs1");
  const Qref=hklToQ(rl,ref);
  const QrefNorm=norm(Qref);
  const QrefXY=[dot(Qref,ex),dot(Qref,ey)];
  const phiRef=QrefNorm>1e-10?rad2deg(Math.atan2(QrefXY[1],QrefXY[0])):0;
  const wavelength=9.044/Math.sqrt(energyMode==="Ef fixed"?Ef:Ei);
  let thetaRef=0;
  if(QrefNorm>1e-10){
    const dRef=2*PI/QrefNorm;
    const arg=wavelength/(2*dRef);
    if(arg>1+1e-12) throw new Error("Reference Q is not accessible at the selected reference energy.");
    thetaRef=rad2deg(Math.asin(clamp(arg,-1,1)));
  }
  const darkRef=checkedValue("darkRef");
  const Qoffset=darkRef==="Reference Q"?90+thetaRef:2*thetaRef;
  const s1Offset=-thetaRef+180-phiRef;

  const S2min=num("S2min"), S1min=num("S1min"), S1max=num("S1max");
  const interp=instrumentInterp(inst,lambdaHalf);
  let hwList;
  if(lambdaHalf) hwList=[0];
  else if(energyMode==="Ef fixed"){
    const EiMax=maxArray(inst.configuration.map(x=>Number(x.Ei)));
    hwList=arange(0,EiMax-Ef,0.2);
  } else {
    hwList=arange(0,Ei,0.2);
  }
  if(hwList.length===0) hwList=[0];

  const regions=[], S2list=[], QmaxList=[];
  const darkKF=[],darkKI=[];
  const addDark=$("addDark").checked && QrefNorm>1e-10;
  const sense=checkedValue("sense");
  const darkRanges=getDarkRanges();

  for(const hw of hwList){
    let EiHw,EfHw;
    if(energyMode==="Ef fixed"){ EiHw=Ef+hw; EfHw=Ef; }
    else { EiHw=Ei; EfHw=Ei-hw; }
    if(EiHw<=0 || EfHw<=0) continue;
    const ki=0.6947*Math.sqrt(EiHw), kf=0.6947*Math.sqrt(EfHw);
    const S2max=Number(interp(EiHw));
    const s1range=linspace(S1min,S1max,200);
    const s2range=linspace(S2min,S2max,200);

    const p1=s1range.map(s1=>calcQ0(s1,S2min,ki,kf,s1Offset,refS1,QrefXY));
    const p2=s2range.map(s2=>calcQ0(S1max,s2,ki,kf,s1Offset,refS1,QrefXY));
    const p3=[...s1range].reverse().map(s1=>calcQ0(s1,S2max,ki,kf,s1Offset,refS1,QrefXY));
    const p4=[...s2range].reverse().map(s2=>calcQ0(S1min,s2,ki,kf,s1Offset,refS1,QrefXY));
    const boundary=[...p1,...p2,...p3,...p4];
    regions.push(boundary); S2list.push(S2max);
    QmaxList.push(Math.max(...boundary.map(norm)));

    const hwKF=[],hwKI=[];
    if(addDark){
      const s2dark=linspace(S2min,S2max,200);
      for(const rawRange of darkRanges){
        let [from,to,offset]=rawRange;
        if(from===0 && to===0) continue;
        if(sense==="+-+") { offset=-offset; from=-from; to=-to; }
        const s1from=offset+from-Qoffset, s1to=offset+to-Qoffset;

        const fromKF=s2dark.map(s2=>calcQDark(s1from,s2,ki,kf,s1Offset,QrefXY,sense));
        const toKF=s2dark.map(s2=>calcQDark(s1to,s2,ki,kf,s1Offset,QrefXY,sense));
        const topKF=linspace(s1from,s1to,100).map(s1=>calcQDark(s1,S2max,ki,kf,s1Offset,QrefXY,sense));
        const bottomKF=linspace(s1to,s1from,100).map(s1=>calcQDark(s1,S2min,ki,kf,s1Offset,QrefXY,sense));
        hwKF.push([...fromKF,...topKF,...[...toKF].reverse(),...bottomKF]);

        const fromKI=s2dark.map(s2=>calcQDark(s1from-(180-s2),s2,ki,kf,s1Offset,QrefXY,sense));
        const toKI=s2dark.map(s2=>calcQDark(s1to-(180-s2),s2,ki,kf,s1Offset,QrefXY,sense));
        const topKI=linspace(s1from-(180-S2max),s1to-(180-S2max),100)
          .map(s1=>calcQDark(s1,S2max,ki,kf,s1Offset,QrefXY,sense));
        const bottomKI=linspace(s1to-(180-S2min),s1from-(180-S2min),100)
          .map(s1=>calcQDark(s1,S2min,ki,kf,s1Offset,QrefXY,sense));
        hwKI.push([...fromKI,...topKI,...[...toKI].reverse(),...bottomKI]);
      }
    }
    darkKF.push(hwKF); darkKI.push(hwKI);
  }

  if(regions.length===0) throw new Error("No accessible energy-transfer points were generated.");

  const Qmax0=QmaxList[0];
  const Uq=hklToQ(rl,U), Vq=hklToQ(rl,V);
  const Ulen=norm(Uq), Vlen=norm(Vq);
  const Mmax=Math.ceil(Qmax0/Ulen)+1, Nmax=Math.ceil(Qmax0/Vlen)+1;
  const Gpoints=[], magPoints=[];
  const QplotLattice=2*Qmax0;
  const kvec=[num("kh"),num("kk"),num("kl")];

  for(let m=-Mmax;m<=Mmax;m++){
    for(let n=-Nmax;n<=Nmax;n++){
      const hkl=add(scale(U,m),scale(V,n));
      const G=hklToQ(rl,hkl);

      if(norm(G)>QplotLattice) continue;
      if(!isAllowedByCentering(hkl,latticeCentering)) continue;

      Gpoints.push({
        x:dot(G,ex),
        y:dot(G,ey),
        label:`(${formatHKL(hkl)})`
      });

      if($("showK").checked){
        for(const s of [1,-1]){
          const hm=add(hkl,scale(kvec,s));
          const Gm=hklToQ(rl,hm);

          if(norm(Gm)<=QplotLattice){
            magPoints.push({
              x:dot(Gm,ex),
              y:dot(Gm,ey),
              label:`(${hm.map(x=>x.toFixed(2)).join(",")})`
            });
          }
        }
      }
    }
  }

  const ringData=[];
  const sampleKey=$("sampleSelect").value;
  if(sampleKey && samples.has(sampleKey)){
    const sample=samples.get(sampleKey);
    const peaks=Array.isArray(sample.peaks)?sample.peaks:[];
    const maxI=peaks.length?Math.max(...peaks.map(p=>Number(p.intensity)||0)):0;
    const qlimit=Math.max(...QmaxList);
    for(const p of peaks){
      const q=2*PI/Number(p.d);
      if(!Number.isFinite(q) || q>qlimit) continue;
      const phi=linspace(0,2*PI,361);
      const ratio=maxI>0?(Number(p.intensity)||0)/maxI:0;
      ringData.push({
        x:phi.map(t=>q*Math.cos(t)), y:phi.map(t=>q*Math.sin(t)),
        color:`rgba(0,0,255,${(0.15+0.70*ratio).toFixed(3)})`,
        hover:`${sample.name||sampleKey} (${p.h}${p.k}${p.l})<br>Q = ${q.toFixed(3)} Å⁻¹<br>I = ${Number(p.intensity).toFixed(1)}`
      });
    }
  }

  return {
    inst,lc,latticeCentering,U,V,rl,ex,ey,ez,
    energyMode,Ei,Ef,lambdaHalf,hwList,
    regions,S2list,QmaxList,darkKF,darkKI,addDark,
    Gpoints,magPoints,ringData,darkRanges,darkRef
  };
}

function renderSingle(cache,index=0){
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const boundary=cache.regions[i];
  const qMax = Math.max(
    ...cache.Gpoints.map(p => Math.hypot(p.x, p.y))
  );

  const labelOffset = 0.03 * qMax;
  const traces=[
    {
      x:boundary.map(p=>p[0]), y:boundary.map(p=>p[1]),
      fill:"toself", name:"Accessible Q", mode:"lines",
      line:{width:0}, fillcolor:"rgba(255,0,0,0.15)"
    },
    {
      x:cache.Gpoints.map(p=>p.x),
      y:cache.Gpoints.map(p=>p.y),
      mode:"markers",
      name:"Nuclear Bragg peaks",
      marker:{color:"black",size:6},
      hovertext:cache.Gpoints.map(p=>p.label),
      hovertemplate:"%{hovertext}<extra></extra>"
    },
    {
      x:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.x),

      y:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.y + labelOffset),

      mode:"text",

      text:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.label),

      textposition:"middle center",
      textfont:{color:"black",size:8},
      showlegend:false,
      hoverinfo:"skip"
    },
    {
      x:cache.magPoints.map(p=>p.x), y:cache.magPoints.map(p=>p.y),
      mode:"markers", name:"Magnetic Bragg peaks",
      marker:{color:"red",size:6},
      hovertext:cache.magPoints.map(p=>p.label), hovertemplate:"%{hovertext}<extra></extra>"
    }
  ];
  for(const ring of cache.ringData){
    traces.push({
      x:ring.x,y:ring.y,mode:"lines",showlegend:false,
      line:{color:ring.color,width:3},hovertemplate:ring.hover+"<extra></extra>"
    });
  }
  if(cache.addDark){
    for(const r of cache.darkKF[i]){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (kf side)",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)"});
    }
    for(const r of cache.darkKI[i]){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (ki side)",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)"});
    }
  }
  traces.push({x:[null],y:[null],mode:"markers",name:`S2 range = ${num("S2min").toFixed(1)} - ${cache.S2list[i].toFixed(1)}°`});

  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  const Qplot=1.2*Math.max(...cache.QmaxList);
  const title=`${cache.inst.name||"Instrument"} | ${energyText}${lam}<br>`+
    `a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å<br>`+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}° | `+
    `Centering: ${cache.latticeCentering} | Plane: (${cache.U.join(",")})-(${cache.V.join(",")})`;

  Plotly.react("singlePlot",traces,{
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Qx (Å⁻¹)",range:[-Qplot,Qplot],dtick:1,showgrid:true,gridcolor:"lightgray",zeroline:true},
    yaxis:{title:"Qy (Å⁻¹)",range:[-Qplot,Qplot],dtick:1,showgrid:true,gridcolor:"lightgray",zeroline:true,scaleanchor:"x",scaleratio:1},
    margin:{l:60,r:20,t:90,b:55},
    legend:{orientation:"h"}
  },{responsive:true});

  $("hwValue").textContent=`${cache.hwList[i].toFixed(1)} meV`;
  renderGeometry(cache);
}

function renderGeometry(cache){
  const traces=[];
  const circle=linspace(0,2*PI,360);
  traces.push({x:circle.map(t=>2*Math.cos(t)),y:circle.map(t=>2*Math.sin(t)),mode:"lines",line:{color:"gray",width:1},showlegend:false,hoverinfo:"skip"});

  cache.darkRanges.forEach((r,i)=>{
    let [from,to,offset]=r;
    if(from===0&&to===0) return;
    let a0=offset+from, a1=offset+to;
    if(a1<a0) a1+=360;
    const aa=linspace(a0,a1,200).map(deg2rad);
    traces.push({x:aa.map(t=>-2*Math.sin(t)),y:aa.map(t=>2*Math.cos(t)),mode:"lines",line:{color:"black",width:6},showlegend:false,hoverinfo:"skip"});
  });

  Plotly.react("geometryPlot",traces,{
    title:{text:"Dark angle<br>(elastic & top view)",x:0.5},
    xaxis:{range:[-2.3,2.3],showgrid:false,zeroline:false,showticklabels:false},
    yaxis:{range:[-2.3,2.3],showgrid:false,zeroline:false,showticklabels:false,scaleanchor:"x",scaleratio:1},
    annotations:[
      {x:0,y:2,ax:0,ay:-0.2,xref:"x",yref:"y",axref:"x",ayref:"y",showarrow:true,arrowhead:3,arrowsize:1.5,arrowwidth:3,arrowcolor:"red"},
      {x:0.8,y:0.8,text:cache.darkRef==="Reference Q"?"Reference Q":"ki",showarrow:false,font:{size:16,color:"red"}}
    ],
    margin:{l:10,r:10,t:60,b:10},showlegend:false
  },{responsive:true,displayModeBar:false});
}

function calculatePowder(){
  const inst=currentInstrument();
  const lc=latticeParams();
  const rv=reciprocalVectors(lc.a,lc.b,lc.c,lc.alpha,lc.beta,lc.gamma);
  const al=norm(rv.astar), bl=norm(rv.bstar), cl=norm(rv.cstar);
  const interp=instrumentInterp(inst,false);
  const energyMode=checkedValue("energyMode");
  const E=num("energyInput"), S2min=num("S2min");
  const qmin=[],qmax=[],hw=[];
  let fixedE=E;

  if(energyMode==="Ef fixed"){
    const Ef=E;
    const EiMax=Math.max(...inst.configuration.map(x=>Number(x.Ei)));
    for(const Ei of arange(Ef+0.01,EiMax,0.1)){
      const s2max=interp(Ei), ki=0.6947*Math.sqrt(Ei), kf=0.6947*Math.sqrt(Ef);
      const tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(Ei-Ef);
    }
  } else {
    const Ei=E;
    const s2max=interp(Ei),ki=0.6947*Math.sqrt(Ei);
    for(const w of arange(0,Ei-0.01,0.1)){
      const Ef=Ei-w;
      if(Ef<=0) continue;
      const kf=0.6947*Math.sqrt(Ef),tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(w);
    }
  }
  if(!qmax.length) throw new Error("No accessible powder range was generated.");

  const traces=[{
    x:[...qmin,...[...qmax].reverse()],
    y:[...hw,...[...hw].reverse()],
    fill:"toself",fillcolor:"rgba(255,150,150,0.35)",
    line:{width:0},name:"Accessible QE range"
  }];
  const shapes=[],annotations=[];
  const Qlim=Math.max(...qmax), hwmax=Math.max(...hw);
  [[al,"red","a*"],[bl,"blue","b*"],[cl,"green","c*"]].forEach(([base,color,label])=>{
    for(let n=1;n<20;n++){
      const q=n*base;
      if(q>Qlim) break;
      shapes.push({type:"line",x0:q,x1:q,y0:0,y1:1,yref:"paper",line:{color,dash:"dot",width:1}});
      annotations.push({x:q,y:hwmax,text:`${n}${label}`,showarrow:false,xshift:15,yshift:20,font:{color}});
    }
  });

  if($("showK").checked){
    const kv=[num("kh"),num("kk"),num("kl")], vals=new Set();
    for(let h=-20;h<=20;h++) for(let k=-20;k<=20;k++) for(let l=-20;l<=20;l++){
      const G=add(add(scale(rv.astar,h),scale(rv.bstar,k)),scale(rv.cstar,l));
      const K=add(add(scale(rv.astar,kv[0]),scale(rv.bstar,kv[1])),scale(rv.cstar,kv[2]));
      for(const s of [1,-1]){
        const q=norm(add(G,scale(K,s)));
        if(q>=1e-6&&q<=Qlim) vals.add(q.toFixed(6));
      }
    }
    [...vals].map(Number).sort((a,b)=>a-b).forEach(q=>{
      shapes.push({type:"line",x0:q,x1:q,y0:0,y1:1,yref:"paper",line:{color:"black",dash:"dot",width:1}});
      annotations.push({x:q,y:hwmax,text:"k*",showarrow:false,xshift:15,yshift:10,font:{color:"black"}});
    });
  }

  const qMargin=0.1*Qlim;
  const title=`${inst.name||"Instrument"} | ${energyMode==="Ef fixed"?"Ef":"Ei"}=${E.toFixed(2)} meV | `+
    `a=${lc.a.toFixed(3)}, b=${lc.b.toFixed(3)}, c=${lc.c.toFixed(3)} Å<br>`+
    `α=${lc.alpha.toFixed(1)}, β=${lc.beta.toFixed(1)}, γ=${lc.gamma.toFixed(1)}°`;

  Plotly.react("powderPlot",traces,{
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Q (Å⁻¹)",range:[0,Qlim+qMargin],showgrid:true,gridcolor:"lightgray",zeroline:false,mirror:true,linecolor:"black"},
    yaxis:{title:"ħω (meV)",range:[0,hwmax*1.1||1],showgrid:true,gridcolor:"lightgray",zeroline:false,mirror:true,linecolor:"black"},
    plot_bgcolor:"white",paper_bgcolor:"white",legend:{x:0.02,y:0.98},
    shapes,annotations,margin:{l:60,r:20,t:80,b:55}
  },{responsive:true});
}

let timer=null;
function scheduleRecalc(){
  clearTimeout(timer);
  timer=setTimeout(recalculate,50);
}
function recalculate(){
  clearError();
  updateEnergyLabel();
  updateModeVisibility();
  try{
    if(checkedValue("sampleMode")==="single"){
      singleCache=calculateSingleCrystal();
      $("hwSlider").min=0;
      $("hwSlider").max=Math.max(0,singleCache.regions.length-1);
      $("hwSlider").step=1;
      const idx=Math.min(Number($("hwSlider").value)||0,singleCache.regions.length-1);
      $("hwSlider").value=idx;
      renderSingle(singleCache,idx);
    } else {
      calculatePowder();
    }
  }catch(err){
    showError(err);
  }
}

$("instrumentSelect").addEventListener("change",()=>{
  applyInstrumentDefaults();
  scheduleRecalc();
});

$("seSelect").addEventListener("change",applySampleEnvironmentDefaults);
$("sampleSelect").addEventListener("change",scheduleRecalc);

$("hwSlider").addEventListener("input",()=>{
  if(singleCache){
    renderSingle(singleCache,Number($("hwSlider").value));
  }
});

document.querySelectorAll("input,select").forEach(el=>{
  if([
    "instrumentSelect",
    "seSelect",
    "sampleSelect",
    "hwSlider"
  ].includes(el.id)) return;

  el.addEventListener("input",scheduleRecalc);
  el.addEventListener("change",scheduleRecalc);
});

async function initialize(){
  clearError();
  updateModeVisibility();
  updateEnergyLabel();

  setStatus("instruments / sample / sample_environments を読み込み中...");

  const [nInstrument,nSample,nSE] = await Promise.all([
    loadJsonDirectory("instruments", instruments),
    loadJsonDirectory("sample", samples),
    loadJsonDirectory("sample_environments", sampleEnvironments)
  ]);

  refreshSelect(
    instruments,
    $("instrumentSelect"),
    null
  );

  refreshSelect(
    samples,
    $("sampleSelect"),
    "None"
  );

  refreshSelect(
    sampleEnvironments,
    $("seSelect"),
    "Standard"
  );

  if(instruments.size===0){
    throw new Error("instruments ディレクトリに装置 JSON がありません。");
  }

  $("instrumentSelect").selectedIndex=0;
  $("sampleSelect").value="";
  $("seSelect").value="";

  applyInstrumentDefaults();
  applySampleEnvironmentDefaults();

  setStatus(
    `${nInstrument} instrument(s), ` +
    `${nSample} sample(s), ` +
    `${nSE} sample environment(s) loaded`
  );

  recalculate();
}

initialize().catch(err=>{
  showError(err);

  setStatus(
    "設定ファイルを読み込めませんでした。 " +
    "Newcode を HTTP サーバーから開いているか確認してください。"
  );
});
