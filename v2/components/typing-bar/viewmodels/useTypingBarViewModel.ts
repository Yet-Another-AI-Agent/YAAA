import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { AttachmentKind, ModelTier } from "../enums/typing-bar.enums";
import type { TypingAttachment, TypingBarProps } from "../interfaces/typing-bar.interfaces";
import { TypingBarLibrary } from "../library/typing-bar-library";
import { createTypingAttachment, nextListPrefix } from "../utils/typing-bar.utils";

export function useTypingBarViewModel({ onSend, initialModelTier = ModelTier.Mid }: Pick<TypingBarProps, "onSend" | "initialModelTier">) {
  const library = useMemo(() => new TypingBarLibrary(initialModelTier), [initialModelTier]);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<TypingAttachment[]>([]);
  const [modelTier, setModelTier] = useState(initialModelTier);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectionKind, setSelectionKind] = useState<AttachmentKind>(AttachmentKind.File);
  const [recording, setRecording] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 168)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 168 ? "auto" : "hidden";
    textarea.scrollTop = textarea.scrollHeight;
  }, [text]);

  const chooseAttachments = (kind: typeof AttachmentKind[keyof typeof AttachmentKind]) => {
    setSelectionKind(kind); setMenuOpen(false);
    const input = fileInputRef.current;
    if (!input) return;
    input.value = ""; input.removeAttribute("webkitdirectory");
    input.accept = kind === AttachmentKind.Image ? "image/*" : kind === AttachmentKind.Video ? "video/*" : kind === AttachmentKind.Audio ? "audio/*" : "*/*";
    if (kind === AttachmentKind.Folder) input.setAttribute("webkitdirectory", "");
    input.click();
  };

  const receiveAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []).map((file) => createTypingAttachment(file, selectionKind, file.name));
    library.addAttachments(selected); setAttachments(library.getAttachments());
  };

  const send = () => {
    library.setText(text); library.setModelTier(modelTier);
    const payload = library.createSendPayload();
    if (!payload.text && payload.attachments.length === 0) return;
    onSend(payload); library.clear(); setText(""); setAttachments([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => { setText(event.target.value); library.setText(event.target.value); };
  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    const target = event.currentTarget;
    const lineStart = target.value.lastIndexOf("\n", target.selectionStart - 1) + 1;
    const prefix = nextListPrefix(target.value.slice(lineStart, target.selectionStart));
    if (prefix) {
      event.preventDefault();
      const nextValue = `${target.value.slice(0, target.selectionStart)}\n${prefix}${target.value.slice(target.selectionEnd)}`;
      setText(nextValue); library.setText(nextValue);
      requestAnimationFrame(() => { const position = target.selectionStart + prefix.length + 1; target.selectionStart = position; target.selectionEnd = position; });
      return;
    }
    if (!event.shiftKey) { event.preventDefault(); send(); }
  };

  const removeAttachment = (id: string) => { library.removeAttachment(id); setAttachments(library.getAttachments()); };
  const startRecording = async () => {
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setVoiceError("Voice recording is unavailable in this browser."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        library.addAttachments([createTypingAttachment(blob, AttachmentKind.Audio, "Voice note.webm")]); setAttachments(library.getAttachments());
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start(); setRecording(true);
    } catch { setVoiceError("Microphone permission was not granted."); }
  };
  const stopRecording = () => { recorderRef.current?.stop(); recorderRef.current = null; setRecording(false); };
  const setTier = (tier: ModelTier) => { setModelTier(tier); library.setModelTier(tier); };

  return { text, attachments, modelTier, menuOpen, recording, voiceError, fileInputRef, textareaRef, setMenuOpen, chooseAttachments, receiveAttachments, send, onTextChange, onTextKeyDown, removeAttachment, startRecording, stopRecording, setTier };
}
