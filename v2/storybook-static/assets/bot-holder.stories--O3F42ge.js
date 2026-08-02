import{r as f,R as n}from"./index-BSnFy17d.js";import{B as d}from"./BotHolder-CVfgefg5.js";import"./Tabs-CjbnKBv3.js";/* empty css             *//* empty css                   */const o={Online:"online",Waiting:"waiting",Offline:"offline"},g=Array.from({length:9},(s,e)=>({id:`bot-${e}`,name:["YAAA","Researcher","Coder","Reviewer","Tester","Docs","Planner","Browser","Verifier"][e],status:e===7||e===8?o.Offline:e===5?o.Waiting:o.Online,role:e===0?"Orchestrator":"Sub-agent",model:"gpt-5",contextWindow:{used:[620,280,740,150,480,320,880,0,0][e],limit:1e3,unit:"tokens"}})),h={title:"v2/Chat/Bot Holder",component:d,args:{initialBots:g}},t={},r={render:s=>{const e=f.useRef(null);return n.createElement("div",null,n.createElement(d,{...s,ref:e}),n.createElement("button",{type:"button",style:{marginTop:12},onClick:()=>{var a;return(a=e.current)==null?void 0:a.updateBot("bot-1",{status:o.Offline,contextWindow:{used:940}})}},"Mark Researcher offline"))}};var i,c,l;t.parameters={...t.parameters,docs:{...(i=t.parameters)==null?void 0:i.docs,source:{originalSource:"{}",...(l=(c=t.parameters)==null?void 0:c.docs)==null?void 0:l.source}}};var u,m,p;r.parameters={...r.parameters,docs:{...(u=r.parameters)==null?void 0:u.docs,source:{originalSource:`{
  render: args => {
    const ref = useRef<BotHolderHandle>(null);
    return <div><BotHolder {...args} ref={ref} /><button type="button" style={{
        marginTop: 12
      }} onClick={() => ref.current?.updateBot("bot-1", {
        status: BotStatus.Offline,
        contextWindow: {
          used: 940
        }
      })}>Mark Researcher offline</button></div>;
  }
}`,...(p=(m=r.parameters)==null?void 0:m.docs)==null?void 0:p.source}}};const w=["MissionTeam","ImperativeUpdates"];export{r as ImperativeUpdates,t as MissionTeam,w as __namedExportsOrder,h as default};
