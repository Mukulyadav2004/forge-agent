import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('The Forge Agent sidebar is missing its root element.');
createRoot(container).render(<App />);
