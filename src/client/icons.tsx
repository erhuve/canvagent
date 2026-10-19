import type { CSSProperties } from "react";

const paths: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  chevron: "m8 10 4 4 4-4",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z",
  history: "M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v6l4 2",
  board: "M4 4h16v16H4zM9 4v16M9 10h11",
  select: "m5 3 14 9-7 1-3 7Z",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  undo: "M4 9h10a6 6 0 0 1 0 12M4 9l5-5M4 9l5 5",
  stop: "M6 6h12v12H6z",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  terminal: "m5 7 5 5-5 5m8 0h6",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  image: "M4 4h16v16H4zM4 16l5-5 5 5 3-3 3 3M15 8h.01",
  external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
  warning: "m12 3 10 18H2Zm0 6v5m0 3h.01",
  reconnect: "M20 7a9 9 0 1 0 1 9M20 3v5h-5",
  chat: "M4 4h16v13H9l-5 4Z",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  compose: "m16 3 5 5M4 20l4-1 13-13-4-4L4 15Zm9-15H4v16h16v-9",
  sidebar: "M3 4h18v16H3ZM9 4v16",
  copy: "M9 9h12v12H9zM15 5V3H3v12h2",
  info: "M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  down: "M12 4v16m-6-6 6 6 6-6",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
};

export function Icon({ name, size = 18, style, className }: { name: string; size?: number; style?: CSSProperties; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className={className}><path d={paths[name] || paths.spark} /></svg>;
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="11" fill="currentColor" /><path d="M28 12H18a8 8 0 0 0 0 16h4a6 6 0 0 0 0-12h-3" stroke="#bad8ac" strokeWidth="2.6" strokeLinecap="round" /><circle cx="28" cy="12" r="2.2" fill="#bad8ac" /></svg>;
}
