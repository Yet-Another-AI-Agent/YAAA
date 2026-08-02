import{w as l,u as t,e as c,f as m}from"./index-1h-ivrgz.js";import{Q as u}from"./QuestionCarousel-Cx46CQ7c.js";import"./index-BSnFy17d.js";/* empty css                          */const v={title:"v2/Interaction/Question Carousel",component:u,args:{onSubmit:m(),questions:[{id:"goal",prompt:"What should we optimize for?",options:[{label:"Speed"},{label:"Quality"}]},{id:"notes",prompt:"Any additional notes?"}]}},a={play:async({canvasElement:i,args:r})=>{const e=l(i);await t.click(e.getByLabelText("Quality")),await t.click(e.getByRole("button",{name:"Next"})),await t.type(e.getByRole("textbox",{name:"Answer for Any additional notes?"}),"Keep the API stable."),await t.click(e.getByRole("button",{name:"Submit answers"})),await c(r.onSubmit).toHaveBeenCalledTimes(1)}};var n,o,s;a.parameters={...a.parameters,docs:{...(n=a.parameters)==null?void 0:n.docs,source:{originalSource:`{
  play: async ({
    canvasElement,
    args
  }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Quality"));
    await userEvent.click(canvas.getByRole("button", {
      name: "Next"
    }));
    await userEvent.type(canvas.getByRole("textbox", {
      name: "Answer for Any additional notes?"
    }), "Keep the API stable.");
    await userEvent.click(canvas.getByRole("button", {
      name: "Submit answers"
    }));
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
  }
}`,...(s=(o=a.parameters)==null?void 0:o.docs)==null?void 0:s.source}}};const b=["Review"];export{a as Review,b as __namedExportsOrder,v as default};
