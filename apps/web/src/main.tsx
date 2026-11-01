import React from "react";
import { createRoot } from "react-dom/client";
import { treaty } from "@elysiajs/eden";
import type { createApp } from "@weft/api";
import { translate } from "@weft/shared";
import "./style.css";

const api = treaty<typeof createApp extends () => infer App ? App : never>(import.meta.env.VITE_API_URL ?? "http://localhost:3000");

function App() {
  const [greeting, setGreeting] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  async function sayHello() {
    const { data, error } = await api.actions.hello.post({ name: "Weft" });
    if (error) setError("Could not reach the example Action.");
    else setGreeting(data.greeting);
  }
  return <main><h1>{translate("app.title")}</h1><p>{translate("app.welcome")}</p><button onClick={sayHello}>{translate("actions.hello")}</button>{greeting && <p role="status">{greeting}</p>}{error && <p role="alert">{error}</p>}</main>;
}

createRoot(document.getElementById("root")!).render(<App />);
