import{r as y,R as n}from"./index-BSnFy17d.js";import{w as g,u as v,e as r,f as k}from"./index-1h-ivrgz.js";import{T as d}from"./TaskList-BEGIfSsf.js";/* empty css                  */const B={title:"v2/Right panel/Task List",component:d,args:{onEvent:k(),initialSubtasks:[{id:"ST-1",title:"Build the task panel",state:"running",roles:["Engineer"],capabilities:["TypeScript"],microTasks:[{id:"MT-1",title:"Create interfaces",state:"completed"},{id:"MT-2",title:"Add tests",state:"running"},{id:"MT-3",title:"Wire the right pane",state:"pending"}]},{id:"ST-2",title:"Polish light and dark themes",state:"pending",capabilities:["CSS"]}]}},s={render:e=>n.createElement("div",{style:{width:340,maxHeight:"100dvh"}},n.createElement(d,{...e})),play:async({canvasElement:e,args:t})=>{const a=g(e);await r(a.getByText("Build the task panel")).toBeVisible(),await r(a.getAllByText("In progress")).not.toHaveLength(0),await r(a.queryByRole("button",{name:"Complete Add tests"})).toBeNull()}},i={render:e=>{const t=y.createRef();return n.createElement("div",{style:{width:340,maxHeight:"100dvh"}},n.createElement(d,{...e,ref:t}),n.createElement("button",{type:"button",onClick:()=>{var a;return(a=t.current)==null?void 0:a.addSubtask({id:"ST-3",title:"New dynamically added subtask",state:"running",microTasks:[]})}},"Add subtask"))},play:async({canvasElement:e})=>{const t=g(e);await v.click(t.getByRole("button",{name:"Add subtask"})),await r(t.getByText("New dynamically added subtask")).toBeVisible()}};var c,l,o;s.parameters={...s.parameters,docs:{...(c=s.parameters)==null?void 0:c.docs,source:{originalSource:`{
  render: args => <div style={{
    width: 340,
    maxHeight: "100dvh"
  }}><TaskList {...args} /></div>,
  play: async ({
    canvasElement,
    args
  }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Build the task panel")).toBeVisible();
    await expect(canvas.getAllByText("In progress")).not.toHaveLength(0);
    await expect(canvas.queryByRole("button", {
      name: "Complete Add tests"
    })).toBeNull();
  }
}`,...(o=(l=s.parameters)==null?void 0:l.docs)==null?void 0:o.source}}};var m,p,u;i.parameters={...i.parameters,docs:{...(m=i.parameters)==null?void 0:m.docs,source:{originalSource:`{
  render: args => {
    const ref = createRef<TaskListHandle>();
    return <div style={{
      width: 340,
      maxHeight: "100dvh"
    }}><TaskList {...args} ref={ref} /><button type="button" onClick={() => ref.current?.addSubtask({
        id: "ST-3",
        title: "New dynamically added subtask",
        state: "running",
        microTasks: []
      })}>Add subtask</button></div>;
  },
  play: async ({
    canvasElement
  }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Add subtask"
    }));
    await expect(canvas.getByText("New dynamically added subtask")).toBeVisible();
  }
}`,...(u=(p=i.parameters)==null?void 0:p.docs)==null?void 0:u.source}}};const x=["NestedTasks","ImperativeUpdates"];export{i as ImperativeUpdates,s as NestedTasks,x as __namedExportsOrder,B as default};
