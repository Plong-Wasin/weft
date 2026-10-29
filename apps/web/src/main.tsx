import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  React.useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/service-worker.js');
    }
  }, []);

  return (
    <main>
      <p className="eyebrow">WEFT · SELF-HOSTED WORK MANAGEMENT</p>
      <h1>Work moves forward, together.</h1>
      <p className="intro">Your team’s projects, tasks, and Knowledge in one private Workspace.</p>
      <section aria-labelledby="getting-started">
        <h2 id="getting-started">Your Workspace is ready</h2>
        <p>Sign in with an account created by your administrator to get started.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
