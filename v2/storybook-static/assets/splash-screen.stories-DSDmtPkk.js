import{r as i,R as s}from"./index-BSnFy17d.js";import{w as S,e as c,u as T,f as k}from"./index-1h-ivrgz.js";/* empty css                      */const I=""+new URL("logo-ndXERjH_.jpg",import.meta.url).href,B=e=>Math.min(100,Math.max(0,Number.isFinite(e)?e:0));function W(e){const a=i.useRef(B(e)),[r,n]=i.useState(a.current),o=i.useRef(null);return a.current=B(e),i.useEffect(()=>{const d=()=>{n(p=>{const l=a.current-p;return Math.abs(l)<.1?(o.current!==null&&cancelAnimationFrame(o.current),o.current=null,a.current):(o.current=requestAnimationFrame(d),p+l*.16)})};return o.current=requestAnimationFrame(d),()=>{o.current!==null&&cancelAnimationFrame(o.current),o.current=null}},[e]),r}function y({title:e="YAAA",progress:a=0,message:r="Initializing agent runtime...",errorMessage:n="Failed to load workspace.",status:o="loading",loaded:d=!1,className:p="",onSuccess:l,onEvent:u}){const t=d?"success":o,E=W(t==="success"||t==="failed"?100:a),h=i.useRef(!1),w=i.useRef(void 0),b=i.useRef(!1);return i.useEffect(()=>{t==="success"&&!h.current&&(h.current=!0,u==null||u({kind:"loaded-success"})),t!=="success"&&(h.current=!1),t==="failed"&&n&&w.current!==n&&(w.current=n,u==null||u({kind:"failed",message:n})),t!=="failed"&&(w.current=void 0)},[t,n,u]),i.useEffect(()=>{t==="success"&&!b.current&&(b.current=!0,l==null||l()),t!=="success"&&(b.current=!1)},[t,l]),s.createElement("main",{className:`v2-splash-screen is-${t} ${p}`,"aria-label":"Splash screen","aria-busy":t==="loading"},s.createElement("div",{className:"v2-splash-glow","aria-hidden":"true"}),s.createElement("div",{className:"v2-splash-content"},s.createElement("img",{src:I,className:"v2-splash-app-logo",alt:`${e} Logo`}),s.createElement("p",{className:"v2-splash-subtitle"},"Yet Another AI Agent"),s.createElement("div",{className:"v2-splash-loader",role:"progressbar","aria-label":"Loading progress","aria-valuemin":0,"aria-valuemax":100,"aria-valuenow":Math.round(E)},s.createElement("span",{style:{width:`${E}%`}})),s.createElement("div",{className:"v2-splash-status"},t==="failed"?n:r)))}try{y.displayName="SplashScreen",y.__docgenInfo={description:"",displayName:"SplashScreen",props:{title:{defaultValue:{value:"YAAA"},description:"",name:"title",required:!1,type:{name:"string"}},progress:{defaultValue:{value:"0"},description:"",name:"progress",required:!1,type:{name:"number"}},message:{defaultValue:{value:"Initializing agent runtime..."},description:"",name:"message",required:!1,type:{name:"string"}},errorMessage:{defaultValue:{value:"Failed to load workspace."},description:"",name:"errorMessage",required:!1,type:{name:"string"}},status:{defaultValue:{value:"loading"},description:"",name:"status",required:!1,type:{name:"enum",value:[{value:'"loading"'},{value:'"failed"'},{value:'"success"'}]}},loaded:{defaultValue:{value:"false"},description:"",name:"loaded",required:!1,type:{name:"boolean"}},className:{defaultValue:{value:""},description:"",name:"className",required:!1,type:{name:"string"}},onSuccess:{defaultValue:null,description:"",name:"onSuccess",required:!1,type:{name:"() => void"}},onEvent:{defaultValue:null,description:"",name:"onEvent",required:!1,type:{name:"(event: SplashScreenEvent) => void"}}}}}catch{}const z={title:"v2/Loading/Splash Screen",component:y,parameters:{layout:"fullscreen"},decorators:[e=>s.createElement("div",{style:{height:"100dvh",minHeight:0}},s.createElement(e,null))],args:{onEvent:k(),onSuccess:k()}},m={args:{progress:42,message:"Loading bot definitions…"},play:async({canvasElement:e})=>{const a=S(e);await c(a.getByText("Loading bot definitions…")).toBeVisible(),await c(a.getByRole("progressbar")).toHaveAttribute("aria-valuenow","42")}},g={args:{progress:64,status:"failed",errorMessage:"Could not connect to the workspace."},play:async({canvasElement:e,args:a})=>{const r=S(e);await c(r.getByText("Could not connect to the workspace.")).toBeVisible(),await c(r.getByRole("progressbar")).toHaveAttribute("aria-valuenow","100"),await c(a.onEvent).toHaveBeenCalledWith({kind:"failed",message:"Could not connect to the workspace."})}},v={args:{progress:100,status:"success",message:"Workspace ready"},play:async({args:e})=>{await c(e.onEvent).toHaveBeenCalledWith({kind:"loaded-success"}),await c(e.onSuccess).toHaveBeenCalledTimes(1)}},f={render:e=>{const[a,r]=i.useState(8);return s.createElement("div",{style:{height:"100dvh"}},s.createElement(y,{...e,progress:a,message:`Receiving update at ${a}%`}),s.createElement("button",{type:"button",onClick:()=>r(n=>n>=92?8:n+37),style:{position:"fixed",bottom:20,left:20}},"Send uneven update"))},play:async({canvasElement:e})=>{const a=S(e);await T.click(a.getByRole("button",{name:"Send uneven update"})),await new Promise(r=>setTimeout(r,100)),await c(a.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow","8")}};var x,R,A;m.parameters={...m.parameters,docs:{...(x=m.parameters)==null?void 0:x.docs,source:{originalSource:`{
  args: {
    progress: 42,
    message: "Loading bot definitions…"
  },
  play: async ({
    canvasElement
  }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Loading bot definitions…")).toBeVisible();
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  }
}`,...(A=(R=m.parameters)==null?void 0:R.docs)==null?void 0:A.source}}};var H,C,V;g.parameters={...g.parameters,docs:{...(H=g.parameters)==null?void 0:H.docs,source:{originalSource:`{
  args: {
    progress: 64,
    status: "failed",
    errorMessage: "Could not connect to the workspace."
  },
  play: async ({
    canvasElement,
    args
  }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Could not connect to the workspace.")).toBeVisible();
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(args.onEvent).toHaveBeenCalledWith({
      kind: "failed",
      message: "Could not connect to the workspace."
    });
  }
}`,...(V=(C=g.parameters)==null?void 0:C.docs)==null?void 0:V.source}}};var N,q,_;v.parameters={...v.parameters,docs:{...(N=v.parameters)==null?void 0:N.docs,source:{originalSource:`{
  args: {
    progress: 100,
    status: "success",
    message: "Workspace ready"
  },
  play: async ({
    args
  }) => {
    await expect(args.onEvent).toHaveBeenCalledWith({
      kind: "loaded-success"
    });
    await expect(args.onSuccess).toHaveBeenCalledTimes(1);
  }
}`,...(_=(q=v.parameters)==null?void 0:q.docs)==null?void 0:_.source}}};var F,L,P;f.parameters={...f.parameters,docs:{...(F=f.parameters)==null?void 0:F.docs,source:{originalSource:`{
  render: args => {
    const [progress, setProgress] = useState(8);
    return <div style={{
      height: "100dvh"
    }}><SplashScreen {...args} progress={progress} message={\`Receiving update at \${progress}%\`} /><button type="button" onClick={() => setProgress(value => value >= 92 ? 8 : value + 37)} style={{
        position: "fixed",
        bottom: 20,
        left: 20
      }}>Send uneven update</button></div>;
  },
  play: async ({
    canvasElement
  }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Send uneven update"
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(canvas.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "8");
  }
}`,...(P=(L=f.parameters)==null?void 0:L.docs)==null?void 0:P.source}}};const J=["Loading","Failed","Success","JerkyInput"];export{g as Failed,f as JerkyInput,m as Loading,v as Success,J as __namedExportsOrder,z as default};
