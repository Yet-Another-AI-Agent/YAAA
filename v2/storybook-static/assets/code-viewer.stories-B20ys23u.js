import{R as C}from"./index-BSnFy17d.js";import{C as M,a as D,V as w}from"./VsCodeDiffViewer-B0uUElXR.js";import"./Button-BwaCv80R.js";/* empty css               *//* empty css                    */const x=`export function createMessage(input: MessageDraft) {
  return { ...input, createdAt: Date.now() };
}

export function renderMessage(message: ChatMessage) {
  return message.messageBody;
}`,B={title:"v2/Code/Viewer",component:M,args:{content:x,language:"typescript",title:"message.models.ts"}},e={args:{previewLines:3}},s={args:{previewLines:99}},r={render:()=>C.createElement(D,{title:"message.models.ts",language:"typescript",before:"return { ...input };",after:"return { ...input, createdAt: Date.now() };"})},t={render:()=>C.createElement(w,{title:"message.models.ts",language:"typescript",oldCode:`export function createMessage(input: MessageDraft) {
  return { ...input };
}

export function renderMessage(message: ChatMessage) {
  return message.messageBody;
}`,newCode:`export function createMessage(input: MessageDraft) {
  return { ...input, createdAt: Date.now() };
}

export function renderMessage(message: ChatMessage) {
  console.info("rendering", message.uuid);
  return message.messageBody;
}`,expandedHeight:"78vh"})};var a,n,o;e.parameters={...e.parameters,docs:{...(a=e.parameters)==null?void 0:a.docs,source:{originalSource:`{
  args: {
    previewLines: 3
  }
}`,...(o=(n=e.parameters)==null?void 0:n.docs)==null?void 0:o.source}}};var i,d,g;s.parameters={...s.parameters,docs:{...(i=s.parameters)==null?void 0:i.docs,source:{originalSource:`{
  args: {
    previewLines: 99
  }
}`,...(g=(d=s.parameters)==null?void 0:d.docs)==null?void 0:g.source}}};var c,p,u;r.parameters={...r.parameters,docs:{...(c=r.parameters)==null?void 0:c.docs,source:{originalSource:`{
  render: () => <CodeDiffViewer title="message.models.ts" language="typescript" before={"return { ...input };"} after={"return { ...input, createdAt: Date.now() };"} />
}`,...(u=(p=r.parameters)==null?void 0:p.docs)==null?void 0:u.source}}};var m,f,l;t.parameters={...t.parameters,docs:{...(m=t.parameters)==null?void 0:m.docs,source:{originalSource:`{
  render: () => <VsCodeDiffViewer title="message.models.ts" language="typescript" oldCode={\`export function createMessage(input: MessageDraft) {
  return { ...input };
}

export function renderMessage(message: ChatMessage) {
  return message.messageBody;
}\`} newCode={\`export function createMessage(input: MessageDraft) {
  return { ...input, createdAt: Date.now() };
}

export function renderMessage(message: ChatMessage) {
  console.info("rendering", message.uuid);
  return message.messageBody;
}\`} expandedHeight="78vh" />
}`,...(l=(f=t.parameters)==null?void 0:f.docs)==null?void 0:l.source}}};const L=["PartialCode","FullCode","Diff","VsCodeInlineDiff"];export{r as Diff,s as FullCode,e as PartialCode,t as VsCodeInlineDiff,L as __namedExportsOrder,B as default};
