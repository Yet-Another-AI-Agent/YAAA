import{f as t}from"./index-1h-ivrgz.js";import{F as s,V as f}from"./Viewer-DbcDRA0O.js";import"./index-BSnFy17d.js";/* empty css               */const k={title:"v2/Files/Viewer",component:f,args:{onClose:t(),onOpenLocation:t(),onOpenInApp:t()},parameters:{layout:"fullscreen"}},e={args:{document:{name:"plan.pdf",kind:s.Pdf,pages:[{content:"Executive summary"},{content:"Implementation details"}]}}},n={args:{document:{name:"proposal.pptx",kind:s.Ppt,slides:[{label:"Problem",content:"The current workflow is fragmented."},{label:"Solution",content:"A focused component system."}]}}},o={args:{document:{name:"proposal.docx",kind:s.Word,content:"A document with selectable sections.",selection:["Summary","Details"]}}};var r,a,c;e.parameters={...e.parameters,docs:{...(r=e.parameters)==null?void 0:r.docs,source:{originalSource:`{
  args: {
    document: {
      name: "plan.pdf",
      kind: FileKind.Pdf,
      pages: [{
        content: "Executive summary"
      }, {
        content: "Implementation details"
      }]
    }
  }
}`,...(c=(a=e.parameters)==null?void 0:a.docs)==null?void 0:c.source}}};var m,d,i;n.parameters={...n.parameters,docs:{...(m=n.parameters)==null?void 0:m.docs,source:{originalSource:`{
  args: {
    document: {
      name: "proposal.pptx",
      kind: FileKind.Ppt,
      slides: [{
        label: "Problem",
        content: "The current workflow is fragmented."
      }, {
        label: "Solution",
        content: "A focused component system."
      }]
    }
  }
}`,...(i=(d=n.parameters)==null?void 0:d.docs)==null?void 0:i.source}}};var l,p,u;o.parameters={...o.parameters,docs:{...(l=o.parameters)==null?void 0:l.docs,source:{originalSource:`{
  args: {
    document: {
      name: "proposal.docx",
      kind: FileKind.Word,
      content: "A document with selectable sections.",
      selection: ["Summary", "Details"]
    }
  }
}`,...(u=(p=o.parameters)==null?void 0:p.docs)==null?void 0:u.source}}};const w=["PdfPages","Slides","WordDocument"];export{e as PdfPages,n as Slides,o as WordDocument,w as __namedExportsOrder,k as default};
