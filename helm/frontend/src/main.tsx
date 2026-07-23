import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import RecipeBank from './pages/RecipeBank'
import './index.css'

// Public recipe page — served at /recipes on any domain, OR at the root of recipes.lionel.place
const isPublicRecipes =
  window.location.hostname === 'recipes.lionel.place' ||
  window.location.pathname === '/recipes' ||
  window.location.pathname === '/recipes/'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPublicRecipes ? (
      // BrowserRouter needed because RecipeBank uses useSearchParams.
      // No basename — recipes.lionel.place serves at the root path.
      <BrowserRouter>
        <main className="page-content" style={{ marginLeft: 0 }}>
          <RecipeBank />
        </main>
      </BrowserRouter>
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  // Auto-reload once when a new service worker takes control, so an already-open tab
  // picks up a fresh deploy instead of silently running stale JS (which caused parse
  // jobs to be acked on delivery by an old bundle). Guarded against the first-install
  // claim (no prior controller) and reload loops. In-flight parses survive the reload
  // via the server-side reconnect (useContextJobs).
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => reg.update())
      .catch(() => {});
  });
}
