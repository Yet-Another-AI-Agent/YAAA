import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { LeftBarChat, LeftBarHandle, LeftBarProject, LeftBarProps } from "./interfaces/left-bar.interfaces";
import "./left-bar.css";
import "./left-bar-search.css";
import "./left-bar-delete.css";

export const LeftBar = forwardRef<LeftBarHandle, LeftBarProps>(function LeftBar({ initialProjects = [], initialChats = [], activeChatId, className = "", onNewChat, onChatClick, onProjectClick, onEvent }, ref) {
  const [projects, setProjects] = useState(initialProjects);
  const [chats, setChats] = useState(initialChats);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedChatId, setSelectedChatId] = useState(activeChatId ?? "");
  const [query, setQuery] = useState("");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const init = (nextProjects: LeftBarProject[], nextChats: LeftBarChat[]) => { setProjects(nextProjects); setChats(nextChats); };
  const addProject = (project: LeftBarProject) => setProjects((current) => [...current.filter((item) => item.id !== project.id), project]);
  const updateProject = (id: string, patch: Partial<Omit<LeftBarProject, "id">>) => setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch } : project));
  const deleteProject = (id: string) => { setProjects((current) => current.filter((project) => project.id !== id)); setChats((current) => current.map((chat) => chat.projectId === id ? { ...chat, projectId: undefined } : chat)); onEventRef.current?.({ kind: "project-delete", projectId: id }); };
  const addChat = (chat: LeftBarChat) => setChats((current) => [...current.filter((item) => item.id !== chat.id), chat]);
  const updateChat = (id: string, patch: Partial<Omit<LeftBarChat, "id">>) => setChats((current) => current.map((chat) => chat.id === id ? { ...chat, ...patch } : chat));
  const deleteChat = (id: string) => { const chat = chats.find((item) => item.id === id); setChats((current) => current.filter((item) => item.id !== id)); onEventRef.current?.({ kind: "chat-delete", chatId: id, chat }); };
  const addAll = (nextProjects: LeftBarProject[], nextChats: LeftBarChat[]) => { setProjects((current) => [...current, ...nextProjects.filter((project) => !current.some((item) => item.id === project.id))]); setChats((current) => [...current, ...nextChats.filter((chat) => !current.some((item) => item.id === chat.id))]); };
  useImperativeHandle(ref, () => ({ init, addAll, addProject, updateProject, deleteProject, addChat, updateChat, deleteChat }), []);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (value: string) => !normalizedQuery || value.toLowerCase().includes(normalizedQuery);
  const permanentProjects = useMemo(() => projects.filter((project) => !project.temporary && (matches(project.name) || chats.some((chat) => chat.projectId === project.id && matches(chat.title)))), [projects, chats, normalizedQuery]);
  const visibleProjectChats = (projectId: string) => chats.filter((chat) => chat.projectId === projectId && matches(chat.title));
  const otherChats = useMemo(() => chats.filter((chat) => { const project = projects.find((item) => item.id === chat.projectId); return (!project || project.temporary) && matches(chat.title); }), [chats, projects, normalizedQuery]);
  const selectChat = (chat: LeftBarChat) => { setSelectedChatId(chat.id); onChatClick?.(chat); onEventRef.current?.({ kind: "chat-open", chat }); };
  const selectProject = (project: LeftBarProject) => { onProjectClick?.(project); onEventRef.current?.({ kind: "project-open", project }); };
  const startNewChat = () => { onNewChat?.(); onEventRef.current?.({ kind: "new-chat" }); };
  return <nav className={`v2-left-bar ${className}`} aria-label="Chat navigation"><button type="button" className="v2-left-bar-new-chat" onClick={startNewChat}>＋ <span>New chat</span></button><label className="v2-left-bar-search"><span aria-hidden="true">⌕</span><input aria-label="Search chats and projects" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" /></label><div className="v2-left-bar-scroll"><section className="v2-left-bar-section"><div className="v2-left-bar-section-title">Projects</div>{permanentProjects.map((project) => <ProjectGroup key={project.id} project={project} chats={visibleProjectChats(project.id)} collapsed={collapsed[project.id] ?? false} onToggle={() => setCollapsed((current) => ({ ...current, [project.id]: !current[project.id] }))} onProjectClick={selectProject} onDelete={() => deleteProject(project.id)} selectedChatId={selectedChatId} onChatClick={selectChat} onDeleteChat={deleteChat} />)}</section><section className="v2-left-bar-section"><div className="v2-left-bar-section-title">Other</div>{otherChats.length === 0 ? <div className="v2-left-bar-empty">No other chats</div> : otherChats.map((chat) => <ChatRow key={chat.id} chat={chat} selected={selectedChatId === chat.id} onClick={selectChat} onDelete={() => deleteChat(chat.id)} />)}</section></div></nav>;
});

function ProjectGroup({ project, chats, collapsed, onToggle, onProjectClick, onDelete, selectedChatId, onChatClick, onDeleteChat }: { project: LeftBarProject; chats: LeftBarChat[]; collapsed: boolean; onToggle: () => void; onProjectClick?: (project: LeftBarProject) => void; onDelete: () => void; selectedChatId: string; onChatClick: (chat: LeftBarChat) => void; onDeleteChat: (id: string) => void }) { return <div className="v2-left-bar-project"><div className="v2-left-bar-project-header"><button type="button" className="v2-left-bar-collapse" aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name}`} onClick={onToggle}>{collapsed ? "⌄" : "⌃"}</button><button type="button" className="v2-left-bar-project-name" onClick={() => onProjectClick?.(project)}>▦ <span>{project.name}</span></button><small>{chats.length}</small><DeleteButton label={`Delete ${project.name}`} onClick={onDelete} /></div>{!collapsed && chats.map((chat) => <ChatRow key={chat.id} chat={chat} selected={selectedChatId === chat.id} onClick={onChatClick} onDelete={() => onDeleteChat(chat.id)} />)}</div>; }
function ChatRow({ chat, selected, onClick, onDelete }: { chat: LeftBarChat; selected: boolean; onClick: (chat: LeftBarChat) => void; onDelete: () => void }) { return <div className={`v2-left-bar-chat-row ${selected ? "is-selected" : ""}`}><button type="button" aria-label={chat.title} className="v2-left-bar-chat" onClick={() => onClick(chat)}><span aria-hidden="true">◇</span><span>{chat.title}</span></button><DeleteButton label={`Delete ${chat.title}`} onClick={onDelete} /></div>; }
function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" className="v2-left-bar-delete" aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>×</button>; }
