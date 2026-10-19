import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const isProject =
  window.location.pathname === '/project' || window.location.pathname.startsWith('/project/');

/** Project Mode is a separate chunk — Simple Mode (/) must not wait for it to parse. */
const ProjectMode = lazy(() => import('./ProjectMode.tsx'));

function ProjectRoot() {
  return (
    <Suspense
      fallback={
        <div className="shell">
          <div className="empty">
            <h1>BiForge</h1>
            <p>Loading…</p>
          </div>
        </div>
      }
    >
      <ProjectMode />
    </Suspense>
  );
}

const Root = isProject ? ProjectRoot : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
