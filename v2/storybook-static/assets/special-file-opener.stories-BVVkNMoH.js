import{R as P}from"./index-BSnFy17d.js";import{w as R,u as p,e as i,f as x}from"./index-1h-ivrgz.js";import{F as o}from"./Viewer-DbcDRA0O.js";import{S as F}from"./SpecialFileOpener-yDqXl7ab.js";/* empty css               *//* empty css                            */const K={title:"v2/Files/Special File Opener",component:F,args:{onOpen:x()}},a={args:{file:{name:"screenshot.png",kind:o.Image,size:24e3}}},n={args:{file:{name:"plan.pptx",kind:o.Ppt,size:204800,location:"/workspace/plan.pptx"}}},r={args:{file:{name:"approval.pdf",kind:o.Pdf,size:102400}}},s={render:t=>P.createElement(F,{...t}),args:{file:{name:"approval.pdf",kind:o.Pdf,size:102400}},play:async({canvasElement:t})=>{const e=R(t);await p.click(e.getByRole("button",{name:"Open approval.pdf"})),await i(e.getByRole("dialog",{name:"approval.pdf viewer"})).toBeInTheDocument(),await p.click(e.getByRole("button",{name:"Close viewer"})),await i(e.queryByRole("dialog",{name:"approval.pdf viewer"})).toBeNull()}};var l,c,m;a.parameters={...a.parameters,docs:{...(l=a.parameters)==null?void 0:l.docs,source:{originalSource:`{
  args: {
    file: {
      name: "screenshot.png",
      kind: FileKind.Image,
      size: 24000
    }
  }
}`,...(m=(c=a.parameters)==null?void 0:c.docs)==null?void 0:m.source}}};var d,f,g;n.parameters={...n.parameters,docs:{...(d=n.parameters)==null?void 0:d.docs,source:{originalSource:`{
  args: {
    file: {
      name: "plan.pptx",
      kind: FileKind.Ppt,
      size: 204800,
      location: "/workspace/plan.pptx"
    }
  }
}`,...(g=(f=n.parameters)==null?void 0:f.docs)==null?void 0:g.source}}};var v,u,w;r.parameters={...r.parameters,docs:{...(v=r.parameters)==null?void 0:v.docs,source:{originalSource:`{
  args: {
    file: {
      name: "approval.pdf",
      kind: FileKind.Pdf,
      size: 102400
    }
  }
}`,...(w=(u=r.parameters)==null?void 0:u.docs)==null?void 0:w.source}}};var k,y,B;s.parameters={...s.parameters,docs:{...(k=s.parameters)==null?void 0:k.docs,source:{originalSource:`{
  render: args => <SpecialFileOpener {...args} />,
  args: {
    file: {
      name: "approval.pdf",
      kind: FileKind.Pdf,
      size: 102400
    }
  },
  play: async ({
    canvasElement
  }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Open approval.pdf"
    }));
    await expect(canvas.getByRole("dialog", {
      name: "approval.pdf viewer"
    })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", {
      name: "Close viewer"
    }));
    await expect(canvas.queryByRole("dialog", {
      name: "approval.pdf viewer"
    })).toBeNull();
  }
}`,...(B=(y=s.parameters)==null?void 0:y.docs)==null?void 0:B.source}}};const b=["Image","Presentation","Pdf","OpensViewer"];export{a as Image,s as OpensViewer,r as Pdf,n as Presentation,b as __namedExportsOrder,K as default};
