import{R as s}from"./index-BSnFy17d.js";import{w as c,u as o,e as i}from"./index-1h-ivrgz.js";import{C as l}from"./ChatShell-CClILWa5.js";import"./CreateChat-CUp0_tLw.js";import"./SpecialFileOpener-yDqXl7ab.js";import"./Viewer-DbcDRA0O.js";/* empty css               *//* empty css                            */import"./MarkdownViewer-1fJT8W4F.js";/* empty css                        */import"./index-CLGLQ5AS.js";import"./jsx-runtime-BjG_zV1W.js";import"./VsCodeDiffViewer-B0uUElXR.js";import"./Button-BwaCv80R.js";/* empty css               *//* empty css                    */import"./MarkdownCommenter-RULF044D.js";/* empty css                           */import"./ResponseReview-CtggtBXq.js";/* empty css                        */import"./QuestionCarousel-Cx46CQ7c.js";/* empty css                          *//* empty css                    */import"./TypingBar-C-2ahqhW.js";/* empty css                   *//* empty css                   */const j={title:"v2/Chat/Shell",component:l,parameters:{layout:"fullscreen"},args:{responseText:"This is a hardcoded YAAA response for the shell demo."}},t={render:a=>s.createElement("div",{style:{height:"100dvh",minHeight:0}},s.createElement(l,{...a})),play:async({canvasElement:a})=>{const e=c(a);await o.type(e.getByRole("textbox",{name:"Message"}),"Test the fixed chat shell"),await o.click(e.getByRole("button",{name:"Send"})),await i(e.getByLabelText("typing")).toBeVisible(),await new Promise(p=>setTimeout(p,2200)),await i(e.getByText("This is a hardcoded YAAA response for the shell demo.")).toBeVisible(),await i(e.getByText("Test the fixed chat shell")).toBeVisible()}};var r,n,m;t.parameters={...t.parameters,docs:{...(r=t.parameters)==null?void 0:r.docs,source:{originalSource:`{
  render: args => <div style={{
    height: "100dvh",
    minHeight: 0
  }}><ChatShell {...args} /></div>,
  play: async ({
    canvasElement
  }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", {
      name: "Message"
    }), "Test the fixed chat shell");
    await userEvent.click(canvas.getByRole("button", {
      name: "Send"
    }));
    await expect(canvas.getByLabelText("typing")).toBeVisible();
    await new Promise(resolve => setTimeout(resolve, 2200));
    await expect(canvas.getByText("This is a hardcoded YAAA response for the shell demo.")).toBeVisible();
    await expect(canvas.getByText("Test the fixed chat shell")).toBeVisible();
  }
}`,...(m=(n=t.parameters)==null?void 0:n.docs)==null?void 0:m.source}}};const q=["Conversation"];export{t as Conversation,q as __namedExportsOrder,j as default};
