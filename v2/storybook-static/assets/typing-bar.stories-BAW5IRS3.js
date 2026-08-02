import{w as x,u as r,e as s,f as w}from"./index-1h-ivrgz.js";import{M,T as B}from"./TypingBar-C-2ahqhW.js";import"./index-BSnFy17d.js";/* empty css                   */const C={title:"v2/Chat/Typing Bar",component:B,parameters:{docs:{description:{component:"Standalone composer surface with attachments, voice recording, model selection, and send payloads."}}},args:{onSend:w()}},e={},a={args:{initialModelTier:M.StateOfArt,placeholder:"Ask anything..."}},t={play:async({canvasElement:k,args:v})=>{const o=x(k),b=o.getByRole("textbox",{name:"Message"});await r.type(b,"Hello from Storybook"),await r.click(o.getByRole("button",{name:"Send"})),await s(v.onSend).toHaveBeenCalledWith(s.objectContaining({text:"Hello from Storybook",attachments:[]}))}},n={parameters:{backgrounds:{default:"dark"}}};var c,i,m;e.parameters={...e.parameters,docs:{...(c=e.parameters)==null?void 0:c.docs,source:{originalSource:"{}",...(m=(i=e.parameters)==null?void 0:i.docs)==null?void 0:m.source}}};var d,l,p;a.parameters={...a.parameters,docs:{...(d=a.parameters)==null?void 0:d.docs,source:{originalSource:`{
  args: {
    initialModelTier: ModelTier.StateOfArt,
    placeholder: "Ask anything..."
  }
}`,...(p=(l=a.parameters)==null?void 0:l.docs)==null?void 0:p.source}}};var g,u,y;t.parameters={...t.parameters,docs:{...(g=t.parameters)==null?void 0:g.docs,source:{originalSource:`{
  play: async ({
    canvasElement,
    args
  }) => {
    const canvas = within(canvasElement);
    const message = canvas.getByRole("textbox", {
      name: "Message"
    });
    await userEvent.type(message, "Hello from Storybook");
    await userEvent.click(canvas.getByRole("button", {
      name: "Send"
    }));
    await expect(args.onSend).toHaveBeenCalledWith(expect.objectContaining({
      text: "Hello from Storybook",
      attachments: []
    }));
  }
}`,...(y=(u=t.parameters)==null?void 0:u.docs)==null?void 0:y.source}}};var S,f,h;n.parameters={...n.parameters,docs:{...(S=n.parameters)==null?void 0:S.docs,source:{originalSource:`{
  parameters: {
    backgrounds: {
      default: "dark"
    }
  }
}`,...(h=(f=n.parameters)==null?void 0:f.docs)==null?void 0:h.source}}};const O=["Empty","WithStateOfArtModel","SendInteraction","Dark"];export{n as Dark,e as Empty,t as SendInteraction,a as WithStateOfArtModel,O as __namedExportsOrder,C as default};
