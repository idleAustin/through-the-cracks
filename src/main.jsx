// Client entrypoint: mounts ThemeProvider, BrowserRouter, and App into #root.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import ThemeProvider from './components/ThemeProvider.jsx';

const routerBase = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') || '/';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter basename={routerBase}>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
