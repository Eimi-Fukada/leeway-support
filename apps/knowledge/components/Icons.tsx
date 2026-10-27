export function Icon({ name, size = 20 }: { name: "book" | "chat" | "plus" | "logout" | "arrow" | "close" | "lock" | "eye" | "upload" | "file" | "search" | "history" | "send" | "back"; size?: number }) {
  const paths = {
    book: <><path d="M4 4.5c3-1 5-.5 8 1.5 3-2 5-2.5 8-1.5v15c-3-1-5-.5-8 1.5-3-2-5-2.5-8-1.5Z"/><path d="M12 6v15"/></>,
    chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-7a8 8 0 1 1 18-3Z"/>,
    plus: <path d="M12 5v14M5 12h14"/>, logout: <><path d="M9 4H5v16h4M9 12h12m-4-4 4 4-4 4"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 14h8M8 17h5"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2"/></>,
    send: <><path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/></>,
    back: <path d="M20 12H4m6-6-6 6 6 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
