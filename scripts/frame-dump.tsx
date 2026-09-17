import React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../src/core/bus.ts";
import { App } from "../src/ui/App.tsx";

const ROWS = 24, COLS = 90;
let buf = "";
const stdout = Object.assign(new Writable({ write(c,_e,cb){ buf += String(c); cb(); return true; } }),
  { columns: COLS, rows: ROWS, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode(){}, ref(){}, unref(){} });
const bus = new EventBus();
const app = render(<App bus={bus} cwd="/Users/sahilpadvi/Desktop/TUI" model="qwen3:8b" version="0.1.0" backend="ollama" sandbox="seatbelt" branch="main" busy={false}
  onSubmit={()=>{}} onCommand={()=>{}} onCancel={()=>{}} onPermission={()=>{}} />,
  { stdout: stdout as any, stdin: stdin as any, patchConsole: false });

const emit = (e:any) => bus.emit({ sessionId:"f", ...e });
emit({ type:"message.started", id:"u1", role:"user" });
emit({ type:"message.completed", id:"u1", text:"write a readme" });
emit({ type:"message.started", id:"a1", role:"assistant" });
emit({ type:"message.completed", id:"a1", text:"1. **Setup instructions** for Ollama, dependencies, and running the client\n- run `bun install` first\n# Heading" });
await new Promise(r=>setTimeout(r,150));
app.unmount(); await app.waitUntilExit();

const frame = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,"").split("\n");
console.log(`terminal rows=${ROWS}; frame emitted ${frame.length} lines`);
const last = frame;
last.forEach((l,i)=>console.log(String(i+1).padStart(3)+" |"+(l.trimEnd()||"")));
