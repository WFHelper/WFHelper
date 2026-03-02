import './app.css';
import App from './App.svelte';
import { initRendererCrashReporting } from './lib/crashReporting.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root mount node');
}

initRendererCrashReporting();

const app = new App({ target: root });

export default app;
