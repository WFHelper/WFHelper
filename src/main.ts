import './app.css';
import App from './App.svelte';
import { initRendererCrashReporting } from './lib/crashReporting.js';

// Initialize theme from localStorage before mounting the app.
// The store's subscribe callback calls applyTheme() immediately on creation,
// so importing the store is sufficient to apply the saved theme.
import './stores/theme.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root mount node');
}

initRendererCrashReporting();

const app = new App({ target: root });

export default app;
