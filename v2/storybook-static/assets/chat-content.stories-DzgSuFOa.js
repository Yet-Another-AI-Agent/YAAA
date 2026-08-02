import{w as x,u as l,e as a,f as B}from"./index-1h-ivrgz.js";import{I as t,M as e,F as n,C as M}from"./CreateChat-CUp0_tLw.js";import"./index-BSnFy17d.js";import"./SpecialFileOpener-yDqXl7ab.js";import"./Viewer-DbcDRA0O.js";/* empty css               *//* empty css                            */import"./MarkdownViewer-1fJT8W4F.js";/* empty css                        */import"./index-CLGLQ5AS.js";import"./jsx-runtime-BjG_zV1W.js";import"./VsCodeDiffViewer-B0uUElXR.js";import"./Button-BwaCv80R.js";/* empty css               *//* empty css                    */import"./MarkdownCommenter-RULF044D.js";/* empty css                           */import"./ResponseReview-CtggtBXq.js";/* empty css                        */import"./QuestionCarousel-Cx46CQ7c.js";/* empty css                          *//* empty css                    */function C(){return[{type:e.RequestMessage,userName:"User",typing:!1,inputTickType:t.Single,messageBody:{kind:"text",text:"Please help me create the next version of my workspace."}},{type:e.ResponseMessage,userName:"YAAA",typing:!1,showInputTick:!1,inputTickType:t.Double,messageBody:{kind:"text",text:"I’m ready to help you shape the next version of your workspace."}},{type:e.AgentThought,userName:"YAAA",typing:!0,inputTickType:t.Loading,messageBody:{kind:"text",text:"Thinking through the cleanest component boundary..."}},{type:e.TaskCreationAgentMessage,userName:"YAAA",typing:!1,inputTickType:t.Single,messageBody:{kind:"form",title:"Implementation plan ready",collapsible:!0,controls:[{id:"accept-plan",kind:n.Button,label:"Accept plan"},{id:"reject-plan",kind:n.Button,label:"Reject plan"}],submitLabel:"Submit plan"}},{type:e.PermissionAgentMessage,userName:"YAAA",typing:!1,inputTickType:t.Single,messageBody:{kind:"form",title:"Allow workspace access?",collapsible:!0,controls:[{id:"scope",kind:n.Radio,label:"This workspace",value:!0},{id:"remember",kind:n.Checkbox,label:"Remember this choice",defaultValue:!1}],submitLabel:"Allow access"}},{type:e.SpecialAgentMessage,userName:"YAAA",typing:!1,inputTickType:t.Single,messageBody:{kind:"file",file:{name:"implementation-plan.md",kind:"markdown",size:18432,location:"/workspace/implementation-plan.md"}}},{type:e.ResponseMessage,userName:"YAAA",typing:!1,showInputTick:!1,inputTickType:t.Single,messageBody:{kind:"response-review",title:"Review the response",content:`# Proposed response

Please review this answer line by line before approving it.`}}]}const R={type:e.PermissionAgentMessage,userName:"YAAA",messageBody:{kind:"form",title:"Allow workspace access?",controls:[{id:"scope",kind:n.Radio,label:"This workspace",value:!0},{id:"remember",kind:n.Checkbox,label:"Remember this choice",defaultValue:!1}],submitLabel:"Allow access"}},X={title:"v2/Chat/Content",component:M,parameters:{docs:{description:{component:"Standalone chat message content. Headers, footers, and the composer are intentionally separate components."}}},args:{onEvent:B()}},s={args:{initialMessages:C()}},o={args:{initialMessages:[]}},i={args:{initialMessages:[R]},play:async({canvasElement:T,args:c})=>{const p=x(T);await l.click(p.getByRole("checkbox",{name:"Remember this choice"})),await l.click(p.getByRole("button",{name:"Allow access"})),await a(c.onEvent).toHaveBeenCalledWith(a.objectContaining({kind:"control-change",controlId:"remember",value:!0})),await a(c.onEvent).toHaveBeenCalledWith(a.objectContaining({kind:"form-action",action:"submit",messageData:a.objectContaining({messageBody:a.objectContaining({submitted:!0})})}))}},r={args:{initialMessages:C()},parameters:{backgrounds:{default:"dark"}}};var m,g,d;s.parameters={...s.parameters,docs:{...(m=s.parameters)==null?void 0:m.docs,source:{originalSource:`{
  args: {
    initialMessages: createDemoMessages()
  }
}`,...(d=(g=s.parameters)==null?void 0:g.docs)==null?void 0:d.source}}};var u,k,y;o.parameters={...o.parameters,docs:{...(u=o.parameters)==null?void 0:u.docs,source:{originalSource:`{
  args: {
    initialMessages: []
  }
}`,...(y=(k=o.parameters)==null?void 0:k.docs)==null?void 0:y.source}}};var b,h,v;i.parameters={...i.parameters,docs:{...(b=i.parameters)==null?void 0:b.docs,source:{originalSource:`{
  args: {
    initialMessages: [interactiveForm]
  },
  play: async ({
    canvasElement,
    args
  }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", {
      name: "Remember this choice"
    }));
    await userEvent.click(canvas.getByRole("button", {
      name: "Allow access"
    }));
    await expect(args.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "control-change",
      controlId: "remember",
      value: true
    }));
    await expect(args.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "form-action",
      action: "submit",
      messageData: expect.objectContaining({
        messageBody: expect.objectContaining({
          submitted: true
        })
      })
    }));
  }
}`,...(v=(h=i.parameters)==null?void 0:h.docs)==null?void 0:v.source}}};var A,f,w;r.parameters={...r.parameters,docs:{...(A=r.parameters)==null?void 0:A.docs,source:{originalSource:`{
  args: {
    initialMessages: createDemoMessages()
  },
  parameters: {
    backgrounds: {
      default: "dark"
    }
  }
}`,...(w=(f=r.parameters)==null?void 0:f.docs)==null?void 0:w.source}}};const Z=["Conversation","Empty","SpecialForm","DarkConversation"];export{s as Conversation,r as DarkConversation,o as Empty,i as SpecialForm,Z as __namedExportsOrder,X as default};
